/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

var breadcrumbs = function(view) {

    /* Dependant interfaces */
    const {Cc, Ci} = require("chrome");
    const { NetUtil } =   window.Cu.import("resource://gre/modules/NetUtil.jsm", {});
    const w = require("ko/windows").getMain();
    const document = w.document;
    const legacy = w.ko;

    var RCService   = Cc["@activestate.com/koRemoteConnectionService;1"]
                        .getService(Ci.koIRemoteConnectionService);
    var koViews     = require("ko/views");
    var os          = Cc["@activestate.com/koOs;1"].getService(Ci.koIOs);
    var osPath      = Cc["@activestate.com/koOsPath;1"].getService(Ci.koIOsPath);
    var xtk         = window.xtk;
    var Iterator    = window.Iterator;

    /* Logging */
    var log = legacy.logging.getLogger('koBreadcrumbs');
    //log.setLevel(legacy.logging.LOG_DEBUG);

    /* Element References */
    var breadcrumbBarWrap, breadcrumbBar, overflowBtn, wrapper;

    /* Templates */
    var template = {};

    /* Contextual information for events */
    var eventContext = {
        activePopup: null,
        menuShowing: false,
        loadInProgress: false
    };

    /* Crumb cache */
    var crumbs = {};
    var crumbFile = null;
    var crumbView = null;

    /* timeout helpers - I know Mook .. */
    var timers = {};

    /* Misc Helpers */
    var pathSeparator = window.navigator.platform.toLowerCase()
                            .indexOf("win32") !== -1 ? '\\' : '/';

    var xv;


    /**
     * "Class" constructor
     * 
     * @returns {Void}
     */
    this.init = function breadcrumbs_init()
    {
        log.debug("Init");
        
        if ( ! view || view.getAttribute("type") != "editor") return;
        
        crumbView = view;

        var $ = require("ko/dom");
        xv = $(view);

        breadcrumbBarWrap = $('#breadcrumbBarWrap').clone();
        breadcrumbBarWrap.removeAttr("id");

        breadcrumbBar           = breadcrumbBarWrap.find('[anonid="breadcrumbBar"]').element();
        template.crumbFile      = breadcrumbBarWrap.find('[anonid="breadcrumbTemplateFile"]').element();
        template.crumbFolder    = breadcrumbBarWrap.find('[anonid="breadcrumbTemplateFolder"]').element();
        template.crumbMenuFile  = breadcrumbBarWrap.find('[anonid="breadcrumbMenuFileTemplate"]').element();
        template.crumbMenuFolder= breadcrumbBarWrap.find('[anonid="breadcrumbMenuFolderTemplate"]').element();
        template.crumbMenupopup = breadcrumbBarWrap.find('[anonid="breadcrumbMenupopupTemplate"]').element();
        template.overflowItem   = breadcrumbBarWrap.find('[anonid="overflowMenuTemplate"]').element();
        overflowBtn             = breadcrumbBarWrap.find('[anonid="breadcrumbOverflowBtn"]').element();
        
        wrapper = xv.findAnonymous("anonid", "statusbar-message-deck-default");
        wrapper.prepend(breadcrumbBarWrap);

        // Bind event listeners
        this.bindListeners();

        // Register Controller 
        //window.controllers.appendController(this.controller);

        this.load();
    };

    /**
     * Reload the current breadcrumbs, currently just links to load()
     */
    this.reload = function breadcrumbs_reload()
    {
        this.load();
        this.checkOverflow();
    };

    /**
     * Load breadcrumbs for the current view, everything starts here
     *
     * @param   {Boolean} noDelay   
     *
     * @returns {Void}
     */
    this.load = function breadcrumbs_load(noDelay = false)
    {
        log.debug("Load");

        // By default the load is delayed so as not to interfere with the
        // event that triggered it. 
        if ( ! noDelay || eventContext.loadInProgress)
        {
            log.debug('Delaying breadcrumb loading');
            clearTimeout(timers.load || {});
            timers.load = setTimeout(this.load.bind(this, true), 100);
            return;
        }

        // Remove old breadcrumbs
        var buttons = breadcrumbBar.querySelectorAll('toolbarbutton') || [];
        for (let button of buttons)
        {
            if (button.hasAttribute('preserve'))
            {
                continue;
            }
            button.parentNode.removeChild(button);
        }

        if ( ! view) {
            log.debug("No view, cancelling load");
            return;
        }
        log.debug("Loading crumbs for view ("+view.uid+" : "+view.title+")");

        // Draw crumbs for current view only if the view has a koDoc
        // and file object
        if ("koDoc" in view && "file" in view.koDoc && view.koDoc.file &&
            (view.koDoc.file.isLocal || view.koDoc.file.isRemoteFile))
        {
            this.drawCrumbs();
        }
        else
        {
            this.drawCrumb(view.title);
        }

        // Allow css styling to differentiate between local and remote files
        breadcrumbBar.classList.remove('is-remote');
        if (view.koDoc && view.koDoc.file && view.koDoc.file.isRemoteFile)
        {
            breadcrumbBar.classList.add('is-remote');
        }

        // Manually set file status as no event is triggered at this point
        this.onUpdateFileStatus(view);

        // Update overflow whenever breadcrumbs are loaded
        this.checkOverflow();

        // Done loading, allow another queued load in case the user
        // is faster than us (slow filesystem?)
        eventContext.loadInProgress = false;
    };

    /**
     * Bind event listeners
     *
     * @returns {Void}
     */
    this.bindListeners = function breadcrumbs_bindListeners()
    {
        this._onLoadBound = this.load.bind(this, false);
        this._checkOverflowBound = this.checkOverflow.bind(this);
        this._menuKeyPressBound = this.onCrumbMenuKeypress.bind(this);
        this._unbindBound = this.unbindListeners.bind(this);
        
        window.addEventListener('file_saved', this._onLoadBound);
        window.addEventListener('current_place_opened', this._onLoadBound);
        window.addEventListener('workspace_restored', this._onLoadBound);
        window.addEventListener('project_opened', this._onLoadBound);

        /* DOM Events */
        window.addEventListener('resize', this._checkOverflowBound);
        window.addEventListener('symbollist_updated', this._checkOverflowBound);
        window.addEventListener('current_view_changed', this._checkOverflowBound);
        window.addEventListener('keydown', this._menuKeyPressBound);

        // Crumb listeners
        this.bindDelegateCrumbListeners();

        window.addEventListener('view_closed', this._unbindBound);

        // Register observer
        var _observerSvc = Cc["@mozilla.org/observer-service;1"].
                            getService(Ci.nsIObserverService);
        _observerSvc.addObserver(this, "file_status", false);
    };
    
    this.unbindListeners = function breadcrumbs_unbindListeners(e)
    {
        if (e.originalTarget != crumbView)
            return;

        window.removeEventListener('file_saved', this._onLoadBound);
        window.removeEventListener('current_place_opened', this._onLoadBound);
        window.removeEventListener('workspace_restored', this._onLoadBound);
        window.removeEventListener('project_opened', this._onLoadBound);
        window.removeEventListener('resize', this._checkOverflowBound);
        window.removeEventListener('symbollist_updated', this._checkOverflowBound);
        window.removeEventListener('current_view_changed', this._checkOverflowBound);
        window.removeEventListener('keydown', this._menuKeyPressBound);
        window.removeEventListener('view_closed', this._unbindBound);

        // Register observer
        var _observerSvc = Cc["@mozilla.org/observer-service;1"].
                            getService(Ci.nsIObserverService);
        _observerSvc.removeObserver(this, "file_status", false);

        // Clear cached
        crumbs = {};
        crumbFile = null;
        crumbView = null;

        // Trash everything
        breadcrumbBarWrap.remove();
        breadcrumbBarWrap = breadcrumbBar = overflowBtn = wrapper = null;
        template = {};
        view = null;
        xv = null;
    };


    /**
     * Bind listeners specific to breadcrumbs
     *
     * @returns {Void} 
     */
    this.bindDelegateCrumbListeners = function breadcrumbs_bindDelegateCrumbListeners()
    {
        let that = this;

        let crumbMousedown = function(e) {
            // Is this a crumb?
            let crumbNode = e.target;
            let uid = crumbNode.id;
            if (crumbNode.matches(".breadcrumb") && uid && (uid in crumbs))
            {
                let crumb = crumbs[uid];

                // Folder
                if (crumbNode.matches(".folder"))
                {
                    let isSystemCtrlOrMeta = false;
                    if (window.navigator.platform.toLowerCase().indexOf("mac") == -1)
                        isSystemCtrlOrMeta = e.ctrlKey;
                    else
                        isSystemCtrlOrMeta = e.metaKey;

                    // Track mouse click events for stuff like Shift+LMB
                    // to view the file in Places
                    if (e.which !== 1) // Only LMB
                        return;

                    // Fast Open shortcut
                    if (e.shiftKey && isSystemCtrlOrMeta)
                    {
                        // on timeout so as not to make the mouseup event hide
                        // commando
                        setTimeout(function() {
                            that.doCommandFastOpen(crumb);
                        }, 100);
                    }
                    // Show in places shortcut
                    else if (e.shiftKey)
                    {
                        that.doCommandShowPlaces(crumb);
                    }
                    // Find in folder shortcut
                    else if (isSystemCtrlOrMeta)
                    {
                        that.doCommandFind(crumb);
                    }
                    // Default - open menupopup
                    else
                    {
                        var menupopup = xtk.domutils.getChildByProperty(
                            crumb.node, 'nodeName', 'menupopup'
                        );
                        menupopup.openPopup(crumb.node, 'after_start');
                        return;
                    }

                    e.stopPropagation();
                }
                // Crumb for a file (not folder)
                else
                {
                    // Show the context menu on any sort of mouse click
                    var contextMenu = document.getElementById('tabContextMenu');
                    contextMenu.openPopup(crumb.node, 'after_start');
                }
            }
        };
        breadcrumbBar.addEventListener("mousedown", crumbMousedown);

        // Bind menupopup listeners
        let filterFunc = function(e) {
            if (e.target.matches("menupopup textbox"))
                that.onCrumbMenuFilter(e.target.closest("menupopup"));
        };
        breadcrumbBar.addEventListener("keyup", filterFunc);

        // We want to load the menupopup contents only when accessed
        let showingFunc = function(e) {
            that.onCrumbMenuShowing(e);
        };
        breadcrumbBar.addEventListener("popupshowing", showingFunc);
        let shownFunc = function(e) {
            that.onCrumbMenuShown(e);
        };
        breadcrumbBar.addEventListener("popupshown", shownFunc);
        let hiddenFunc = function(e) {
            that.onCrumbMenuHidden(e);
        };
        breadcrumbBar.addEventListener("popuphidden", hiddenFunc);

        // On mouse move remove menuactive attribute from irrelevant
        // items
        let popupMousemove = function(e) {
            if (e.target.matches("menupopup"))
            {
                var elems = xtk.domutils.getChildrenByAttribute(
                    e.target, '_moz-menuactive', 'true'
                );
                for (let [k,elem] in Iterator(elems))
                {
                    if (elem != e.target)
                    {
                        elem.removeAttribute("_moz-menuactive");
                    }
                }
            }
        };
        breadcrumbBar.addEventListener("mousemove", popupMousemove);

        // Set up unbinds
        let unbinder = function(e) {
            if (e.originalTarget != crumbView)
                return;
            breadcrumbBar.removeEventListener("mousedown", crumbMousedown);
            breadcrumbBar.removeEventListener("keyup", filterFunc);
            breadcrumbBar.removeEventListener("popupshowing", showingFunc);
            breadcrumbBar.removeEventListener("popupshown", shownFunc);
            breadcrumbBar.removeEventListener("popuphidden", hiddenFunc);
            breadcrumbBar.removeEventListener("mousemove", popupMousemove);
            window.removeEventListener('view_closed', unbinder);
        };
        window.addEventListener('view_closed', unbinder);
    };

    /*
     * Command controller, for our keybinding based commands
     */
    this.controller =
    {
        /**
         * Open the crumb menu for the parent folder of the currently opened
         * file, allows for the breadcrumbs to be fully controlled by
         * only the keyboard
         *
         * @returns {Void}
         */
        do_cmd_openCrumbMenu: function()
        {
            var crumb = breadcrumbBar.querySelector(".breadcrumb:last-child")
                                     .previousSibling;
            if ( ! crumb.classList.contains('breadcrumb'))
            {
                return;
            }

            var menupopup = crumb.querySelector("menupopup");
            menupopup.openPopup(crumb, 'before_start');
        },

        /**
         * Check whether command is supported
         *
         * @param   {String} command
         *
         * @returns {Bool}
         */
        supportsCommand: function(command)
        {
            return ("do_" + command) in this;
        },

        /**
         * Check whether command is enabled
         *
         * @param   {String} command
         *
         * @returns {Bool} 
         */
        isCommandEnabled: function(command)
        {
            var method = "is_" + command + "_enabled";
            return (method in this) ?
                    this["is_" + command + "_enabled"]() : true;
        },

        /**
         * Execute command
         *
         * @param   {String} command
         *
         * @returns {Mixed} 
         */
        doCommand: function(command)
        {
            return this["do_" + command]();
        }
    };

    /**
     * Observe custom events (in this case only file_status)
     *
     * @param   {String} subject
     * @param   {String} topic
     * @param   {String} data
     *
     * @returns {Void}
     */
    this.observe = function(subject, topic, data)
    {
        if (topic != 'file_status' || ! crumbFile) return; 

        var urllist = data.split('\n');

        for (var u=0; u < urllist.length; ++u)
        {
            if (urllist[u] == crumbFile.file.getUri())
                this.onUpdateFileStatus();
        }
    };

    /**
     * Update the SCC file status for the given view
     *
     * @param   {Object} view
     *
     * @returns {Void}
     */
    this.onUpdateFileStatus = function openfiles_onUpdateFileStatus()
    {
        var view = crumbView;
        var koDoc = view && view.koDoc;
        var koFile = koDoc && koDoc.file;
        if (!koDoc || !koFile || !crumbFile || koDoc.isUntitled ||
            koFile.path != crumbFile.file.getPath())
        {
            return;
        }

        var element = crumbFile.node;

        // Scc status.
        if (!("sccType" in koFile) || koFile.sccType == '')
        {
            element.setAttribute("collapsed", "true");
        }
        else
        {
            element.removeAttribute("collapsed");

            var action = koFile.sccAction;
            var hasConflict = (action == 'conflict') || koFile.sccConflict;

            // Set SCC Extra Status
            if (hasConflict)
            {
                element.setAttribute('file_scc_status_extra', 'scc_conflict');
            }
            else if (koFile.sccNeedSync)
            {
                element.setAttribute('file_scc_status_extra', 'scc_needSync');
            }
            else
            {
                element.removeAttribute('file_scc_status_extra');
            }

            // Set SCC status
            if (action && action != 'conflict')
            {
                element.setAttribute('file_scc_status', 'scc_' + action);
            }
            else if (!hasConflict)
            {
                element.setAttribute('file_scc_status', 'scc_ok');
            }
        }
    };

    /**
     * Execute a command on a breadcrumb menu item, this function proxies
     * the command in order to automatically supply relevant breadcrumb info
     *
     * @param   {String} command
     * @param   {Object} menuitem node
     *
     * @returns {Void} 
     */
    this.onCommandMenuItem = function breadcrumbs_onCommandMenuItem(command,
                                                              menuitem)
    {
        var popupmenu = menuitem.parentNode;

        if ( ! ('doCommand' + command in this))
        {
            log.error(
                "Attempting to call non-existant command: " + command
            );
            return;
        }

        this['doCommand' + command](popupmenu, menuitem);
    };

    /**
     * Select a crumb, opens its menupopup
     *
     * @param   {Object} crumb
     * @param   {Object} menuitem node
     *
     * @returns {Void} 
     */
    this.doCommandSelect = function breadcrumbs_onCommandSelect(popupmenu, menuitem)
    {
        popupmenu.file.getChild(menuitem.getAttribute("label")).open();
    };

    /**
     * Open the Find in File dialog with the current crumb's folder selected
     *
     * @param   {Object} crumb
     *
     * @returns {Void}
     */
    this.doCommandFastOpen = function breadcrumbs_doCommandFastOpen(popupmenu)
    {
        if ( ! popupmenu.file || popupmenu.file.isRemote()) return;

        var path = popupmenu.file.getPath();
        var commando = require("commando/commando");
        var sdkFile = require("ko/file");

        commando.selectScope("scope-files");
        commando.setSubscope({
            id: path,
            name: sdkFile.basename(path),
            description: path,
            isScope: true,
            scope: "scope-files",
            data: {
                path: path,
                type: "dir"
            }
        });
        commando.show();
    };

    /**
     * Open the Find in File dialog with the current crumb's folder selected
     *
     * @param   {Object} crumb
     *
     * @returns {Void} 
     */
    this.doCommandFind = function breadcrumbs_onCommandFind(popupmenu)
    {
        if ( ! popupmenu.file || popupmenu.file.isRemote()) return;
        
        legacy.launch.findInFiles(null, [popupmenu.file.getPath()]);
    };

    /**
     * Show the current folder in Places
     *
     * @param   {Object} crumb
     *
     * @returns {Void} 
     */
    this.doCommandShowPlaces = function breadcrumbs_onCommandShowPlaces(popupmenu)
    {
        if ( ! popupmenu.file || popupmenu.file.isRemote()) return;
        
        var URI = popupmenu.file.getUri();

        // Strip trailing slash
        if (['/', '\\'].indexOf(URI.substr(-1)) !== -1)
        {
            URI = URI.substr(0, URI.length-1);
        }

        if ( ! legacy.uilayout.isTabShown('placesViewbox'))
        {
            legacy.commands.doCommandAsync('cmd_viewPlaces');
        }

        legacy.places.manager.showTreeItemByFile(URI);
    };

    /**
     * Filter crumb menu items based on input
     *
     * @param   {Object} menupopup node
     *
     * @returns {Void}
     */
    this.onCrumbMenuFilter = function breadcrumbs_onCrumbMenuFilter(menupopup)
    {
        // Set element references
        var textbox = xtk.domutils.getChildByProperty(
            menupopup, 'nodeName', 'textbox'
        );
        var items = menupopup.querySelectorAll("menuitem, menu");
        var highlighted = false; // Record whether we have a highlighted item

        // Prepare the filter Regex
        var filter = textbox.value.toLowerCase();
        filter = filter.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, "\\$&");
        filter = filter.replace(/\s+?/, '.*?');
        filter = new RegExp(filter);

        // Iterate over menu items and apply the filter to them
        var firstItem = null;
        for (let [k,item] in Iterator(items))
        {
            if ((item.classList.contains('file-item') ||
                 item.classList.contains('folder-item'))
                && textbox.value != ""
                && ! item.label.toLowerCase().match(filter))
            {
                item.removeAttribute("_moz-menuactive");
                item.setAttribute("collapsed", true);
                continue;
            }

            item.removeAttribute("collapsed");

            // Record first visible item
            if ( ! firstItem && item.classList.contains('file-item'))
            {
                firstItem = item;
            }

            // Record whether the unfiltered item is highlighted so we
            // don't need to highlight anything ourselves
            if (item.hasAttribute("_moz-menuactive"))
            {
                highlighted = true;
            }
        }

        // If nothing is highlighted, highlight the first unfiltered item
        // manually
        if ( ! highlighted)
        {

            if (firstItem)
            {
                firstItem.setAttribute("_moz-menuactive", "true");
            }
        }
    };

    /**
     * Triggered right before a crumb popupmenu is shown
     *
     * @param   {Object} menupopup node
     *
     * @returns {Void}
     */
    this.onCrumbMenuShowing = function breadcrumb_onCrumbMenuShowing(event)
    {
        var menupopup = event.target;

        //var lastPopup = eventContext.popupChain.slice(-1)[0];
        //if (eventContext.popupChain.length && lastPopup != menupopup.parentNode)
        //{
        //    eventContext.popupChain[0].hidePopup();
        //    eventContext.popupChain = [];
        //}
        //
        //eventContext.popupChain.push(menupopup);

        this.drawCrumbMenuItems(menupopup);
    };

    /**
     * Triggered once the crumb popupmenu is shown
     *
     * @param   {Object} menupopup node
     *
     * @returns {Void}
     */
    this.onCrumbMenuShown = function breadcrumb_onCrumbMenuShown( event)
    {
        var menupopup = event.target;

        if ("file" in menupopup)
        {
            log.debug("Showing menu for crumb: " + menupopup.file.getFilename());
        }
        eventContext.activePopup = menupopup;

        // Record element references
        var textbox = xtk.domutils.getChildByProperty(
            menupopup, 'nodeName', 'textbox'
        );
        if (textbox)
        {
            // Ensure textbox is selected and ready to be typed in
            textbox.focus();
            textbox.setSelectionRange(0,0);
        }

        // Highlight the first menu item
        var menuItem = xtk.domutils.getChildByProperty(
            menupopup, 'nodeName', ['menu','menuitem']
        );
        if (menuItem)
        {
            menuItem.setAttribute("_moz-menuactive", "true");
        }

        // Set contextual information for events
        eventContext.menuShowing = true;
    };

    /**
     * Triggered once the crumb popupmenu has been hidden
     *
     * @param   {Object} menupopup node
     *
     * @returns {Void}
     */
    this.onCrumbMenuHidden = function breadcrumb_onCrumbMenuHidden(event)
    {
        if (!eventContext.menuShowing)
        {
            return;
        }

        var menupopup = event.target;

        // Set contextual information for events
        eventContext.menuShowing = false;

        // Reset textbox (filter) value
        var textbox = xtk.domutils.getChildByProperty(
            menupopup, 'nodeName', 'textbox'
        );
        if (textbox)
        {
            textbox.value = "";
            xtk.domutils.fireEvent(textbox, "keyup");
        }

        // Clear selection
        var elems = xtk.domutils.getChildrenByAttribute(
            menupopup, '_moz-menuactive', 'true'
        );
        for (let [k,elem] in Iterator(elems))
        {
            elem.removeAttribute("_moz-menuactive");
        }

        // Ensure editor has focus
        legacy.commands.doCommandAsync('cmd_focusEditor');
    };

    /**
     * Triggered on key press in a crumb popupmenu
     *
     * Since we can only capture events inside a popupmenu when we disable
     * the standard keypress events we need to re-implement them
     *
     * @param   {Object} e Event
     *
     * @returns {Void}
     */
    this.onCrumbMenuKeypress = function breadcrumb_onCrumbMenuKeypress(e)
    {
        if (legacy.views.manager.currentView != crumbView)
            return;
        
        // Ensure we don't process rogue events due to shady focussing
        if ( ! eventContext.menuShowing)
        {
            return;
        }

        switch (e.keyCode)
        {
            /**
             * ENTER
             *
             * Select a menu item
             */
            case 13:
                e.preventDefault();
                e.stopPropagation();

                var popup = eventContext.activePopup;
                var menuitem = xtk.domutils.getChildByAttribute(
                    popup, '_moz-menuactive', 'true'
                );

                xtk.domutils.fireEvent(menuitem, 'command');

                break;

            /**
             * ESCAPE
             *
             * If the textbox has text in it, reset it to be empty,
             * otherwise hide the popup
             */
            case 27:
                e.preventDefault();
                e.stopPropagation();

                var popup = eventContext.activePopup;
                var textbox = xtk.domutils.getChildByProperty(
                    popup, 'nodeName', 'textbox'
                );

                if (textbox && textbox.value != "")
                {
                    textbox.value = "";
                    xtk.domutils.fireEvent(textbox, "keyup");
                }
                else
                {
                    popup.hidePopup();

                    if ("parentMenu" in popup)
                    {
                        eventContext.activePopup = popup.parentMenu;
                        var menuitem = xtk.domutils.getChildByAttribute(
                            popup.parentMenu, '_moz-menuactive', 'true'
                        );

                        // Todo: figure out a way to do this without setTimeout,
                        // popuphidden event is called before the menuitem is blurred
                        setTimeout(function() {
                            menuitem.setAttribute("_moz-menuactive", "true");
                        },10);
                    }
                }

                break;

            /**
             * LEFT / RIGHT
             *
             * Navigate across the different crumbs
             */
            case 37:
            case 39:
                this.onCrumbMenuNavX(e);
                break;

            // Up / Down arrow
            case 38:
            case 40:
                this.onCrumbMenuNavY(e);
                break;
        }
    };

    this.onCrumbMenuNavX = function breadcrumbs_onCrumbMenuNavX(e)
    {
        // Allow left / right on textbox elem
        var popup = eventContext.activePopup;
        if ((e.target.nodeName == 'textbox' && e.target.value != ''))
        {
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        var menuitem = xtk.domutils.getChildByAttribute(
            popup, '_moz-menuactive', 'true'
        );

        if ("parentMenu" in popup && e.keyCode == 37)
        {
            popup.hidePopup();

            eventContext.activePopup = popup.parentMenu;
            var menuitem = xtk.domutils.getChildByAttribute(
                popup.parentMenu, '_moz-menuactive', 'true'
            );

            // Todo: figure out a way to do this without setTimeout,
            // popuphidden event is called before the menuitem is blurred
            setTimeout(function() {
                menuitem.setAttribute("_moz-menuactive", "true");
            },10);
        }
        else if (menuitem && menuitem.nodeName == "menu" && e.keyCode == 39)
        {
            var childPopup = xtk.domutils.getChildByProperty(
                menuitem, 'nodeName', 'menupopup'
            );
            if (childPopup)
            {
                childPopup.openPopup(menuitem, 'end_after');
            }
        }
        else
        {
            var _sibling = function(node)
            {
                var sibCrumb = e.keyCode == 37 ?
                                    node.previousSibling :
                                    node.nextSibling;
                if (sibCrumb && sibCrumb.classList.contains('overflown'))
                {
                    return _sibling(sibCrumb);
                }
                return sibCrumb;
            };

            // Get the next / previous sibling crumb
            if ("crumb" in popup)
            {
                var crumbNode = popup.crumb.node;
                var sibCrumb = _sibling(crumbNode);
                var sibMenu = xtk.domutils.getChildByProperty(
                    sibCrumb, 'nodeName', 'menupopup'
                );
            }
            
            if (typeof sibMenu == 'undefined' || ! sibMenu)
            {
                log.debug('Reached end of iterable crumbs');
                return;
            }

            // Show the sibling crumb's menu
            eventContext.activePopup.hidePopup();
            sibMenu.openPopup(sibCrumb, 'before_start');
        }
    };

    this.onCrumbMenuNavY = function breadcrumbs_onCrumbMenuNavY(e)
    {
        e.preventDefault();
        e.stopPropagation();

        // Get the active menu item to start from, if any
        var menupopup = eventContext.activePopup;
        var menuitem = xtk.domutils.getChildByAttribute(
            menupopup, '_moz-menuactive', 'true'
        );
        if ( ! menuitem)
        {
            // No active menu, get the first or last menu item
            var sibMenu = xtk.domutils.getChildrenByProperty(menupopup, 'nodeName', ['menu', 'menuitem']);
            sibMenu = sibMenu[(e.keyCode == 38 ?
                            sibMenu.length -1 : 0)];
        }
        else
        {
            /* Get the sibling for the given menu */
            var _sibling = function(menu)
            {
                var sibling = e.keyCode == 38 ?
                                menu.previousSibling :
                                menu.nextSibling;
                if ( ! sibling)
                {
                    // Get first / last menu item, depending on keycode
                    sibling = xtk.domutils.getChildrenByProperty(menupopup, 'nodeName', ['menu', 'menuitem'])
                    return sibling[(e.keyCode == 38 ?
                                        sibling.length -1 : 0)];
                }
                // Skip over irrelevant items
                if (['menuitem','menu'].indexOf(sibling.nodeName) == -1
                    || sibling.hasAttribute("collapsed"))
                {
                    return _sibling(sibling, e.keyCode);
                }
                return sibling;
            }
            var sibMenu = _sibling(menuitem);
        }

        // No sibling menu was found
        if ( ! sibMenu)
        {
            return;
        }

        // Remove active indicator from previous menu
        if (menuitem)
        {
            menuitem.removeAttribute("_moz-menuactive");
            menuitem.blur();
        }

        // Select new menu item
        //sibMenu.scrollIntoView(true); // Todo: implement after moz upgrade
        sibMenu.setAttribute("_moz-menuactive", "true");
        sibMenu.focus();
    };

    /**
     * Render all the crumbs to the DOM, prepares crumb info then directs
     * it to drawCrumb()
     *
     * @returns {Void} 
     */
    this.drawCrumbs = function breadcrumbs_drawCrumb()
    {
        var view = crumbView;
        log.debug('Drawing crumbs for view: ' + view.title + ' :: ' + view.koDoc.file.path);

        // Reset the activeCrumb
        eventContext.activeCrumb = null;

        if ( ! view.koDoc.file.isRemoteFile)
        {
            // Init file pointer for currently opened file
            var file = Cc["@mozilla.org/file/local;1"]
                        .createInstance(Ci.nsILocalFile);
            file.initWithPath(view.koDoc.file.path);

            // Get project path so we can exclude it from the crumbs
            var projectPath;
            if (legacy.projects.manager.currentProject)
            {
                projectPath = legacy.projects.manager.currentProject.liveDirectory;
            }

            // Iterate through files in reverse and queue them to be drawn
            // as breadcrumbs, stop at the project path
            var files = [];
            while (file)
            {
                files.push(file);

                if (file.path == projectPath)
                {
                    break;
                }
                file = file.parent;
            }
            
            // Direct each file in the path to drawCrumb()
            for (let x=files.length-1;x>=0;x--)
            {
                this.drawCrumb(files[x].leafName, files[x]);
            }
        }
        else
        {
            var filePath = '';
            var splitter = view.koDoc.file.path.match(/^[a-z]\:\\/i) ? '\\' : '/';
            var bits = view.koDoc.file.path.split(splitter);
            
            for (let x=0;x<bits.length;x++)
            {
                filePath += (filePath == splitter ?  '' : splitter) + bits[x];
                this.drawCrumb(bits[x], filePath);
            }
        }
    };

    /**
     * Draw a crumb with the given information
     *
     * @param   {String} name
     * @param   {String} filePath
     *
     * @returns {Void} 
     */
    this.drawCrumb = function breadcrumbs_drawCrumb(name, filePath = false)
    {
        log.debug('Drawing crumb: ' + name);

        // Generate unique ID for this crumb
        var uuidGenerator = Cc["@mozilla.org/uuid-generator;1"]
                                .getService(Ci.nsIUUIDGenerator);
        var uid = uuidGenerator.generateUUID();
        var view = crumbView;
        
        // Parse our file through our own file "classes" in order to have
        // a uniform interface to access them through
        var file;
        if (filePath)
        {
            if (view.koDoc.file.isRemoteFile)
            {
                file = new fileRemote(filePath,
                                      view.koDoc.file.URI,
                                      view.koDoc.file.path == filePath);
            }
            else
            {
                file = new fileLocal(filePath);
            }
        }

        // Get template for file/folder
        if ( ! file || file.isFile())
        {
            var crumb = this._getTemplate('crumbFile');
        }
        else
        {
            var crumb = this._getTemplate('crumbFolder');
        }

        // Set basic crumb attributes
        crumb.setAttribute('id' , uid);
        crumb.setAttribute('label', (name || "(root)"));
        crumb.setAttribute(
            'style',
            'z-index: ' +
                (100 - breadcrumbBar.querySelectorAll(".breadcrumb").length));

        // Load in the native file icon if available
        if (file && file.isFile() &&
            legacy.prefs.getBoolean("native_mozicons_available", false))
        {
            crumb.setAttribute(
                'image', "koicon://" + file.getFilename() + "?size=14"
            );
        }

        // Check whether this crumb holds the root project folder and
        // indicate it as such
        if (legacy.projects.manager.currentProject && file &&
            legacy.projects.manager.currentProject.liveDirectory == file.getPath())
        {
            crumb.classList.add("project-folder");
        }

        // Record important breadcrumb information
        crumbs[uid] = {node: crumb, view: view, file: file};

        if ( file && file.isDirectory())
        {
            // Inject menupopup element
            var menupopup = this._getTemplate('crumbMenupopup');
            menupopup.file = file;
            menupopup.crumb = crumbs[uid];
            crumb.appendChild(menupopup);
        }

        if ( file && file.isFile())
        {
            crumbFile = crumbs[uid];
        }

        // Add the created breadcrumb to the DOM
        breadcrumbBar.appendChild(crumb);
    };

    /**
     * Draw the menu items for a crumb menu
     *
     * @param   {Object} menupopup node
     *
     * @returns {Void}
     */
    this.drawCrumbMenuItems = function breadcrumbs_drawCrumMenuItems(menupopup)
    {
        if ( ! ("file" in menupopup))
        {
            return;
        }
        
        // Skip rendering the menu contents if it was already done
        if (menupopup.hasAttribute("rendered"))
        {
            log.debug("Already rendered - skip populating");
            return;
        }

        log.debug("Populating menu");

        var file = menupopup.file;

        // Get the first menu separator, we'll beed it to inser items before
        var separator = xtk.domutils.getChildByProperty(
            menupopup, 'nodeName', 'menuseparator'
        );

        // Iterate through child files of current file
        var children = file.getChildrenSorted();
        for (let [k,child] in Iterator(children))
        {
            // Create menu item
            if (child.isFile())
            {
                var elem = this._getTemplate('crumbMenuFile');
                elem.setAttribute(
                    'image', "koicon://" + child.getFilename() + "?size=14"
                );
            }
            else
            {
                var elem = this._getTemplate('crumbMenuFolder');

                var popup = this._getTemplate('crumbMenupopup');
                popup.file = child;
                popup.crumb = menupopup.crumb;
                popup.parentMenu = menupopup;
                elem.appendChild(popup);
            }

            elem.setAttribute('label', child.getFilename());

            menupopup.insertBefore(elem, separator);
        }

        log.debug("Added " + children.length + " items");

        // If there are no menu items we don't need a separator
        if (children.length==0)
        {
            separator.setAttribute('collapsed', true);
        }

        // Prevent the menu from being rendered again
        menupopup.setAttribute('rendered', true);
    };

    /**
     * Check whether the breadcrumb bar is overflown and if so
     * start collapsing crumbs into a small overflow menu button
     *
     * @returns {Void} 
     */
    this.checkOverflow = function breadcrumbs_checkOverflow(noDelay = false)
    {
        if (legacy.views.manager.currentView != crumbView)
            return;
        
        if ( ! noDelay)
        {
            clearTimeout(this.checkOverflow._timer);
            this.checkOverflow._timer = setTimeout(this.checkOverflow.bind(this, true), 100);
            return;
        }
        
        // Start off with resetting everything to normal
        overflowBtn.setAttribute("collapsed", true);
        breadcrumbBar.classList.remove("overflown");
        
        var buttons = breadcrumbBar.querySelectorAll(
            "toolbarbutton.overflown,toolbarbutton.first-child"
        );
        for (let [k,button] in Iterator(buttons))
        {
            button.classList.remove('first-child');
            button.classList.remove('overflown');
        }

        //var msgPane = document.getElementById('statusbar-message-panel');
        //if (msgPane.scrollWidth > msgPane.boxObject.width)
        //{
        //    var statusbarWith = document.getElementById('statusbarviewbox').boxObject.width;
        //    var width = Math.floor(statusbarWidth / 4);
        //
        //    if (breadcrumbbarWrap.boxObject.width > width)
        //    {
        //        breadcrumbbarWrap.setAttribute("width", width);
        //    }
        //}

        // Now check whether the breadcrumb bar is actually overflown
        var overflower = wrapper.element();
        var diff = Math.abs(overflower.scrollWidth - overflower.boxObject.width);
        if (diff > 5)
        {
            overflowBtn.removeAttribute("collapsed");
            breadcrumbBar.classList.add("overflown");
            
            // Iterate through the crumbs, collapsing one at a time until
            // the breadcrumb bar is no longer overflown
            var i = 0, width = overflower.scrollWidth;
            buttons = breadcrumbBar.querySelectorAll("toolbarbutton.breadcrumb");

            while (width > overflower.boxObject.width)
            {
                if ( ! (i in buttons))
                {
                    break;
                }

                let button = buttons[i++];
                
                width -= button.boxObject.width;
                button.classList.add("overflown");
            }

            // If there is still a button visible, mark the first one as the
            // first child
            if (i in buttons)
            {
                buttons[i].classList.add("first-child");
            }

            // Render menu options for all the collapsed crumbs
            this.drawOverflowMenu();
        }
    };
    this.checkOverflow._timer = null;

    /**
     * Create the overflow menu items
     *
     * @returns {Void} 
     */
    this.drawOverflowMenu = function breadcrumbs_drawOverflowMenu()
    {
        // Start off with removing old items
        var menupopup = xtk.domutils.getChildByProperty(
            overflowBtn, 'nodeName', 'menupopup'
        );
        var items = xtk.domutils.getChildrenByProperty(
            menupopup, 'nodeName', 'menu'
        );
        for (let [k,item] in Iterator(items))
        {
            item.parentNode.removeChild(item);
        }

        // Iterate over the collapsed crumbs and add them to the menu
        var buttons = breadcrumbBar.querySelectorAll("toolbarbutton.overflown");
        for (let [k,button] in Iterator(buttons))
        {
            // Create the menu 
            let item = this._getTemplate('overflowItem');
            item.setAttribute("label", button.getAttribute("label"));
            item.breadcrumb = button;

            var id = button.getAttribute("id");
            var crumb = crumbs[id];

            var popup = this._getTemplate('crumbMenupopup');
            popup.file = crumb.file;
            popup.crumb = crumb;
            popup.parentMenu = menupopup;
            item.appendChild(popup);

            menupopup.appendChild(item);
        }
    };

    /**
     * Template helper, clones the template node and removes attributes
     * which are not meant to be part of the template
     *
     * @param   {String} name
     *
     * @returns {Object} node
     */
    this._getTemplate = function breadcrumbs_getTemplate(name)
    {
        var elem = template[name].cloneNode(true);
        elem.removeAttribute('collapsed');
        elem.removeAttribute('preserve');
        return elem;
    };

    var fileLocal = function(path)
    {
        var cache = {};

        if (path instanceof Ci.nsILocalFile)
        {
            cache.file = path;
            path = cache.file.path;
        }

        this._getFile = function()
        {
            if ( ! ("file" in cache))
            {
                log.debug("Initiating local file: " + path);
                
                cache.file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
                cache.file.initWithPath(path);
            }
            return cache.file;
        };

        this.open = function()
        {
            legacy.open.URI(path);
        };

        this.getChild = function(name)
        {
            var children = this.getChildren();
            if (name in children)
            {
                return children[name];
            }
            return false;
        };

        this.getChildren = function()
        {
            if ( ! ("children" in cache))
            {
                cache.children = {};
                var children = os.listdir(path, {});
                for (let [k,file] in Iterator(children))
                {
                    cache.children[file] = new fileLocal(path + pathSeparator + file);
                }
            }
            return cache.children;
        };

        this.getChildrenSorted = function()
        {
            if ( ! ("childrenSorted" in cache))
            {
                cache.childrenSorted = [];
                var children = this.getChildren();

                for (let [name,child] in Iterator(children))
                {
                    cache.childrenSorted.push(child);
                }

                cache.childrenSorted.sort(function(a,b) {
                    if (a.isDirectory() && b.isFile()) return -1;
                    if (a.isFile() && b.isDirectory()) return 1;
                    return a.getFilename().localeCompare(b.getFilename());
                });
            }
            return cache.childrenSorted;
        };

        this.getFilename = function()
        {
            return this._getFile().leafName;
        };
        
        this.getUri = function()
        {
            return NetUtil.newURI(this._getFile()).spec;
        };

        this.getPath = function()
        {
            return path;
        };

        this.isFile = function()
        {
            return this._getFile().isFile();
        };

        this.isDirectory = function()
        {
            return this._getFile().isDirectory();
        };

        this.isRemote = function()
        {
            return false;
        };

        return this;
    };

    var fileRemote = function(path, conn, isFile = null)
    {
        var cache = {};

        this.init = function()
        {
            if (typeof path == "object")
            {
                cache.file = path;
                path = path.getFilepath();
            }

            if (typeof conn == "string")
            {
                cache.uri = conn;
                conn = RCService.getConnectionUsingUri(conn);
            }
        };

        this._getFile = function(forListing, refresh = false)
        {
            if ("file" in cache && forListing)
            {
                refresh = (cache.file.isDirectory() && cache.file.needsDirectoryListing);
            }

            if ( ! ("file" in cache) || refresh)
            {
                log.debug("Initiating remote file: " + path + ", refresh: " + refresh);
                cache.file = conn.list(path, refresh);

                if ( ! refresh && forListing && cache.file.isDirectory())
                {
                    return this._getFile(true, true);
                }
            }
            
            return cache.file;
        };

        this.open = function()
        {
            legacy.open.URI(this.getUri());
        };

        this.getChild = function(name)
        {
            var children = this.getChildren();
            if (name in children)
            {
                return children[name];
            }
            return false;
        };

        this.getChildren = function()
        {
            if ( ! ("children" in cache))
            {
                cache.children = {};
                var children = this._getFile(true).getChildren({});
                for (let [,child] in Iterator(children))
                {
                    cache.children[child.getFilename()] = new fileRemote(child, conn);
                }
            }
            return cache.children;
        };

        this.getChildrenSorted = function()
        {
            if ( ! ("childrenSorted" in cache))
            {
                cache.childrenSorted = [];
                var children = this.getChildren();

                for (let [name,child] in Iterator(children))
                {
                    cache.childrenSorted.push(child);
                }

                cache.childrenSorted.sort(function(a,b) {
                    if (a.isDirectory() && b.isFile()) return -1;
                    if (a.isFile() && b.isDirectory()) return 1;
                    return a.getFilename().localeCompare(b.getFilename());
                });
            }
            return cache.childrenSorted;
        };

        this.getFilename = function()
        {
            // parse filename from path so we don't need to query the server
            return this.getPath().replace(/.*(?:\/|\\)/,'');
        };

        this.getUri = function()
        {
            if ( ! ("uri" in cache))
            {
                cache.uri = conn.protocol + "://";
                if (conn.alias)
                {
                    cache.uri += conn.alias;
                }
                else
                {
                    if (conn.username)
                    {
                        cache.uri += conn.username;
                        cache.uri += "@";
                    }
                    cache.uri += conn.server;
                    if (conn.port)
                    {
                        cache.uri += ":"+conn.port;
                    }
                }

                cache.uri += path;

                log.debug('remoteFile getUri: ' + cache.uri);
            }

            return cache.uri;
        };

        this.getPath = function()
        {
            return path;
        };

        this.isFile = function()
        {
            return ! this.isDirectory();
        };

        this.isDirectory = function()
        {
            return this._getFile().isDirectory();
        };

        this.isRemote = function()
        {
            return true;
        };
        
        this.init();

        return this;
    };
    
    this.init();

};

module.exports.init = function(view)
{
    return new breadcrumbs(view);
}
