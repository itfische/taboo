/*
 * Copyright 2007 Jesse Andrews and Manish Singh
 *  
 * This file may be used under the terms of of the
 * GNU General Public License Version 2 or later (the "GPL"),
 * http://www.gnu.org/licenses/gpl.html
 *  
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 * 
 * Portions are derived from the Mozilla nsSessionStore component:
 *
 * Copyright (C) 2006 Simon Bünzli <zeniko@gmail.com>
 *
 * Contributor(s):
 * Dietrich Ayala <autonome@gmail.com>
 *
 * Other portions derived from Firefox bookmarks code.
 *
 * Copyright (C) 1998 Netscape Communications Corporation.
 *
 * Contributor(s):
 *   Ben Goodger <ben@netscape.com> (Original Author)
 *   Joey Minta <jminta@gmail.com>
 *
 * Other portions derived from Flock favorites code.
 *
 * Copyright (C) 2005-2007 Flock Inc.
 */

const TB_CONTRACTID = '@oy/taboo;1';
const TB_CLASSID    = Components.ID('{962a9516-b177-4083-bbe8-e10f47cf8570}');
const TB_CLASSNAME  = 'Taboo Service';


const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

/* from nspr's prio.h */
const PR_RDONLY      = 0x01;
const PR_WRONLY      = 0x02;
const PR_RDWR        = 0x04;
const PR_CREATE_FILE = 0x08;
const PR_APPEND      = 0x10;
const PR_TRUNCATE    = 0x20;
const PR_SYNC        = 0x40;
const PR_EXCL        = 0x80;

const CAPABILITIES = [
  "Subframes", "Plugins", "Javascript", "MetaRedirects", "Images"
];

const IMAGE_FULL_WIDTH = 500;
const IMAGE_FULL_HEIGHT = 500;

const IMAGE_THUMB_WIDTH = 125;
const IMAGE_THUMB_HEIGHT = 125;


function getObserverService() {
  return Cc['@mozilla.org/observer-service;1']
    .getService(Ci.nsIObserverService);
}

function getBoolPref(prefName, defaultValue) {
  try {
    var prefs = Cc['@mozilla.org/preferences-service;1']
      .getService(Ci.nsIPrefBranch);
    return prefs.getBoolPref(prefName);
  }
  catch (e) {
    return defaultValue;
  }
}


/* MD5 wrapper */
function hex_md5_stream(stream) {
  var hasher = Components.classes["@mozilla.org/security/hash;1"]
    .createInstance(Components.interfaces.nsICryptoHash);
  hasher.init(hasher.MD5);

  hasher.updateFromStream(stream, stream.available());
  var hash = hasher.finish(false);

  var ret = '';
  for (var i = 0; i < hash.length; ++i) {
    var hexChar = hash.charCodeAt(i).toString(16);
    if (hexChar.length == 1)
      ret += '0';
    ret += hexChar;
  }

  return ret;
}

function hex_md5(s) {
  var stream = Components.classes["@mozilla.org/io/string-input-stream;1"]
    .createInstance(Components.interfaces.nsIStringInputStream);
  stream.setData(s, s.length);

  return hex_md5_stream(stream);
}


/*
 * Taboo Info Instance
 */

function TabooInfo(url, title, description, favicon, imageURL, thumbURL,
                   created, updated, data) {
  this.url = url;
  this.title = title;
  this.description = description;
  this.favicon = favicon;
  this.imageURL = imageURL;
  this.thumbURL = thumbURL;
  this.created = new Date(created);
  this.updated = new Date(updated);
  this.data = data;
}

TabooInfo.prototype = {
  QueryInterface: function(iid) {
    if (!iid.equals(Ci.nsISupports) &&
        !iid.equals(Ci.oyITabooInfo)) {
      throw Cr.NS_ERROR_NO_INTERFACE;
    }
    return this;
  }
}

/*
 * Taboo Service Component
 */


function snapshot(win, outputWidth, outputHeight) {
  var content = win.content;

  var canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");

  var realW = content.document.body ? content.document.body.clientWidth
                                    : content.innerWidth;
  var realH = content.innerHeight;

  var pW = outputWidth * 1.0 / realW;
  var pH = outputHeight * 1.0 / realH;

  var p = pW;

  if (pH < pW) {
    p = pH;
  }

  var w = p * realW;
  var h = p * realH;

  canvas.setAttribute("width", Math.floor(w));
  canvas.setAttribute("height", Math.floor(h));

  var ctx = canvas.getContext("2d");
  ctx.scale(p, p);
  ctx.drawWindow(content, content.scrollX, content.scrollY, realW, realH, "rgb(0,0,0)");

  var imageData = canvas.toDataURL();
  return win.atob(imageData.substr('data:image/png;base64,'.length));
}


function TabooStorageSQL() {
  this._tabooDir = Cc['@mozilla.org/file/directory_service;1']
    .getService(Ci.nsIProperties).get('ProfD', Ci.nsILocalFile);
  this._tabooDir.append('taboo');

  if (!this._tabooDir.exists())
    this._tabooDir.create(Ci.nsIFile.DIRECTORY_TYPE, 0700);

  var dbfile = this._tabooDir.clone();
  dbfile.append('taboo.sqlite');

  var DB = loadSubScript('chrome://taboo/content/sqlite.js').DB;
  this._db = new DB(dbfile);

  this._db.Table('taboo_data', {
    url         : 'TEXT PRIMARY KEY',
    title       : 'TEXT',
    description : 'TEXT',
    md5         : 'TEXT',
    favicon     : 'TEXT',
    full        : 'TEXT',
    created     : 'INTEGER',
    updated     : 'INTEGER',
    deleted     : 'INTEGER'
  });

  this._store = this._db.taboo_data;
}

TabooStorageSQL.prototype = {
  save: function TSSQL_save(url, description, data, fullImage, thumbImage) {
    var title = data.entries[data.index - 1].title;

    if (!title) {
      var ios = Cc['@mozilla.org/network/io-service;1']
        .getService(Ci.nsIIOService);
      var uri = ios.newURI(url, null, null);

      if (uri.path.length > 1) {
        var parts = uri.path.split('/');
        while (!title && parts.length)
          title = parts.pop();
      }

      if (!title)
        title = uri.host;
    }

    var updated = Date.now();

    var entry = this._store.find(url);

    if (!entry) {
      entry = this._store.new();
      entry.url = url;
      entry.md5 = hex_md5(url);
      entry.created = updated;
    }

    if (description) {
      entry.description = description;
    }

    entry.title = title;
    entry.updated = updated;
    entry.deleted = null;
    entry.full = data.toSource();

    entry.save();

    this._saveImage(fullImage, this._getImageFile(entry.md5));
    this._saveImage(thumbImage, this._getThumbFile(entry.md5));
  },
  saveFavicon: function TSSQL_saveFavicon(url, favicon) {
    var entry = this._store.find(url);
    if (entry) {
      entry.favicon = favicon;
      entry.save();
    }
  },
  exists: function TSSQL_exists(url) {
    return Boolean(this._store.find(url));
  },
  delete: function TSSQL_delete(url) {
    this._deleteOp(url, Date.now());
  },
  undelete: function TSSQL_undelete(url) {
    this._deleteOp(url, null);
  },
  reallyDelete: function TSSQL_reallyDelete(url) {
    var entry = this._store.find(url);
    if (entry) {
      entry.destroy();
    }

    try {
      var file, md5 = hex_md5(url);

      file = this._getImageFile(md5);
      file.remove(false);

      file = this._getThumbFile(md5);
      file.remove(false);
    }
    catch (e) { }
  },
  retrieve: function TSSQL_retrieve(url) {
    var entry = this._store.find(url);
    if (!entry)
      return null;

    var ios = Cc['@mozilla.org/network/io-service;1']
      .getService(Ci.nsIIOService);
    var fileHandler = ios.getProtocolHandler('file')
      .QueryInterface(Ci.nsIFileProtocolHandler);

    var imageFile = this._getImageFile(entry.md5);
    var imageURL = fileHandler.getURLSpecFromFile(imageFile);

    var thumbFile = this._getThumbFile(entry.md5);
    var thumbURL = fileHandler.getURLSpecFromFile(thumbFile);
    if (!thumbFile.exists()) {
      thumbURL = imageURL;
    }

    var data = entry.full.replace(/\r\n?/g, '\n');
    var sandbox = new Cu.Sandbox('about:blank');
    var state = Cu.evalInSandbox(data, sandbox);

    return new TabooInfo(url, entry.title, entry.description, entry.favicon,
                         imageURL, thumbURL, entry.created, entry.updated,
                         state);
  },
  getURLs: function TSSQL_getURLs(filter, deleted) {
    var condition = [];

    var sortkey, sql = '';

    if (filter) {
      sql += '(url LIKE ?1 or title LIKE ?1 or description LIKE ?1) and ';
      // TODO: escape %'s before passing in
      condition.push('%' + filter + '%');
    }

    if (deleted) {
      sql += 'deleted IS NOT NULL';
      sortkey = 'deleted DESC';
    } else {
      sql += 'deleted IS NULL';
      sortkey = 'updated DESC';
    }

    condition.unshift(sql);

    var results = this._store.find(condition, sortkey);
    return results.map(function(entry) { return entry.url });
  },
  _getImageFile: function TSSQL__getImageFile(id) {
    var file = this._tabooDir.clone();
    file.append(id + '.png');
    return file;
  },
  _getThumbFile: function TSSQL__getPreviewFile(id) {
    var file = this._tabooDir.clone();
    file.append(id + '-' + IMAGE_THUMB_WIDTH + '.png');
    return file;
  },
  _saveImage: function TSSQL__saveImage(imageData, file) {
    try {
      var ostream = Cc['@mozilla.org/network/file-output-stream;1']
        .createInstance(Ci.nsIFileOutputStream);
      ostream.init(file, PR_WRONLY | PR_CREATE_FILE | PR_TRUNCATE, 0600, 0);

      ostream.write(imageData, imageData.length);
      ostream.close();
    }
    catch (e) { }
  },
  _deleteOp: function TSSQL__deleteOp(url, deleted) {
    var entry = this._store.find(url);
    if (entry) {
      entry.deleted = deleted;
      entry.save();
    }
  }
}


function TabooService() {
  var obs = getObserverService();
  obs.addObserver(this, 'profile-after-change', false);
}

TabooService.prototype = {
  _init: function TB__init() {
    this._storage = new TabooStorageSQL();
  },
  observe: function TB_observe(subject, topic, state) {
    var obs = getObserverService();

    switch (topic) {
      case 'profile-after-change':
        obs.removeObserver(this, 'profile-after-change');
        this._init();
        break;
    }
  },

  save: function TB_save(aDescription) {
    var wm = Cc["@mozilla.org/appshell/window-mediator;1"]
      .getService(Ci.nsIWindowMediator);
    var win = wm.getMostRecentWindow('navigator:browser');

    var tabbrowser = win.getBrowser();
    var selectedBrowser = tabbrowser.selectedBrowser;
    var selectedTab = tabbrowser.selectedTab;

    var currentTab = -1;
    var browsers = tabbrowser.browsers;
    for (var i = 0; i < browsers.length; i++) {
      if (browsers[i] == selectedBrowser)
        currentTab = i;
    }

    if (currentTab == -1)
      return false;

    var ss = Cc['@mozilla.org/browser/sessionstore;1']
      .getService(Ci.nsISessionStore);
    var winJSON = "(" + ss.getWindowState(win) + ")";

    if (getBoolPref('extensions.taboo.debug', false))
      dump(winJSON + "\n");

    var sandbox = new Cu.Sandbox('about:blank');
    var winState = Cu.evalInSandbox(winJSON, sandbox);

    var state = winState.windows[0].tabs[currentTab];

    var url = state.entries[state.index - 1].url;
    url = url.replace(/#.*$/, '');

    var fullImage = snapshot(win, IMAGE_FULL_WIDTH, IMAGE_FULL_HEIGHT);
    var thumbImage = snapshot(win, IMAGE_THUMB_WIDTH, IMAGE_THUMB_HEIGHT);

    this._storage.save(url, aDescription, state, fullImage, thumbImage);

    var faviconURL = selectedTab.getAttribute('image');
    if (faviconURL) {
      var ios = Cc['@mozilla.org/network/io-service;1']
        .getService(Ci.nsIIOService);
      var chan = ios.newChannel(faviconURL, null, null);
      var listener = new tabooFavIconLoadListener(url, faviconURL, chan,
                                                  this._storage);
      chan.notificationCallbacks = listener;
      chan.asyncOpen(listener, null);
    }

    return true;
  },
  isSaved: function TB_isSaved(aURL) {
    return this._storage.exists(aURL);
  },
  delete: function TB_delete(aURL) {
    this._storage.delete(aURL);
  },
  undelete: function TB_undelete(aURL) {
    this._storage.undelete(aURL);
  },
  reallyDelete: function TB_reallyDelete(aURL) {
    this._storage.reallyDelete(aURL);
  },
  get: function TB_get(filter, deleted) {
    var urls = this._storage.getURLs(filter, deleted);

    var enumerator = {
      _urls: urls,
      _storage: this._storage,
      getNext: function() {
        var url = this._urls.shift();
        return this._storage.retrieve(url);
      },
      hasMoreElements: function() {
        return this._urls.length > 0;
      }
    }

    return enumerator;
  },

  /* Because sessionstore doesn't let us restore a single tab, we cut'n'paste
   * a bunch of code here
   */
  open: function TB_open(aURL, aWhere) {
    var info = this._storage.retrieve(aURL);
    var tabData = info.data;

    // helper hash for ensuring unique frame IDs
    var idMap = { used: {} };

    var wm = Cc['@mozilla.org/appshell/window-mediator;1']
      .getService(Ci.nsIWindowMediator);
    var win = wm.getMostRecentWindow('navigator:browser');

    var loadInBackground = getBoolPref("browser.tabs.loadBookmarksInBackground", false);

    var tabbrowser = win.getBrowser();

    var tab;
    switch (aWhere) {
      case 'current':
        tab = tabbrowser.mCurrentTab;
        break;
      case 'tabshifted':
        loadInBackground = !loadInBackground;
        // fall through
      case 'tab':
        tab = tabbrowser.loadOneTab('about:blank', null, null, null,
                                    loadInBackground, false);
        break;
      default:
        return;
    }

    var _this = this;

    var browser = win.getBrowser().getBrowserForTab(tab);
    var history = browser.webNavigation.sessionHistory;

    if (history.count > 0) {
      history.PurgeHistory(history.count);
    }
    history.QueryInterface(Ci.nsISHistoryInternal);

    browser.markupDocumentViewer.textZoom = parseFloat(tabData.zoom || 1);

    for (var i = 0; i < tabData.entries.length; i++) {
      history.addEntry(this._deserializeHistoryEntry(tabData.entries[i], idMap), true);
    }

    // make sure to reset the capabilities and attributes, in case this tab gets reused
    var disallow = (tabData.disallow)?tabData.disallow.split(","):[];
    CAPABILITIES.forEach(function(aCapability) {
      browser.docShell["allow" + aCapability] = disallow.indexOf(aCapability) == -1;
    });
    Array.filter(tab.attributes, function(aAttr) {
      return (_this.xulAttributes.indexOf(aAttr.name) > -1);
    }).forEach(tab.removeAttribute, tab);
    if (tabData.xultab) {
      tabData.xultab.split(" ").forEach(function(aAttr) {
        if (/^([^\s=]+)=(.*)/.test(aAttr)) {
          tab.setAttribute(RegExp.$1, decodeURI(RegExp.$2));
        }
      });
    }

    // notify the tabbrowser that the tab chrome has been restored
    var event = win.document.createEvent("Events");
    event.initEvent("SSTabRestoring", true, false);
    tab.dispatchEvent(event);

    var activeIndex = (tabData.index || tabData.entries.length) - 1;
    try {
      browser.webNavigation.gotoIndex(activeIndex);
    }
    catch (ex) { } // ignore an invalid tabData.index

    // restore those aspects of the currently active documents
    // which are not preserved in the plain history entries
    // (mainly scroll state and text data)
    browser.__SS_restore_data = tabData.entries[activeIndex] || {};
    browser.__SS_restore_text = tabData.text || "";
    browser.__SS_restore_tab = tab;
    browser.__SS_restore = this.restoreDocument_proxy;
    browser.addEventListener("load", browser.__SS_restore, true);
  },
  _deserializeHistoryEntry: function TB__deserializeHistoryEntry(aEntry, aIdMap) {
    var shEntry = Cc["@mozilla.org/browser/session-history-entry;1"].
                  createInstance(Ci.nsISHEntry);
    
    var ioService = Cc["@mozilla.org/network/io-service;1"].
                    getService(Ci.nsIIOService);
    shEntry.setURI(ioService.newURI(aEntry.url, null, null));
    shEntry.setTitle(aEntry.title || aEntry.url);
    shEntry.setIsSubFrame(aEntry.subframe || false);
    shEntry.loadType = Ci.nsIDocShellLoadInfo.loadHistory;
    
    if (aEntry.cacheKey) {
      var cacheKey = Cc["@mozilla.org/supports-PRUint32;1"].
                     createInstance(Ci.nsISupportsPRUint32);
      cacheKey.data = aEntry.cacheKey;
      shEntry.cacheKey = cacheKey;
    }
    if (aEntry.ID) {
      // get a new unique ID for this frame (since the one from the last
      // start might already be in use)
      var id = aIdMap[aEntry.ID] || 0;
      if (!id) {
        for (id = Date.now(); aIdMap.used[id]; id++);
        aIdMap[aEntry.ID] = id;
        aIdMap.used[id] = true;
      }
      shEntry.ID = id;
    }
    
    var scrollPos = (aEntry.scroll || "0,0").split(",");
    scrollPos = [parseInt(scrollPos[0]) || 0, parseInt(scrollPos[1]) || 0];
    shEntry.setScrollPosition(scrollPos[0], scrollPos[1]);
    
    if (aEntry.postdata) {
      var stream = Cc["@mozilla.org/io/string-input-stream;1"].
                   createInstance(Ci.nsIStringInputStream);
      stream.setData(aEntry.postdata, -1);
      shEntry.postData = stream;
    }
    
    if (aEntry.children && shEntry instanceof Ci.nsISHContainer) {
      for (var i = 0; i < aEntry.children.length; i++) {
        shEntry.AddChild(this._deserializeHistoryEntry(aEntry.children[i], aIdMap), i);
      }
    }
    
    return shEntry;
  },
  restoreDocument_proxy: function TB_restoreDocument_proxy(aEvent) {
    // wait for the top frame to be loaded completely
    if (!aEvent || !aEvent.originalTarget || !aEvent.originalTarget.defaultView || aEvent.originalTarget.defaultView != aEvent.originalTarget.defaultView.top) {
      return;
    }
    
    var textArray = this.__SS_restore_text ? this.__SS_restore_text.split(" ") : [];
    function restoreTextData(aContent, aPrefix) {
      textArray.forEach(function(aEntry) {
        if (/^((?:\d+\|)*)(#?)([^\s=]+)=(.*)$/.test(aEntry) && (!RegExp.$1 || RegExp.$1 == aPrefix)) {
          var document = aContent.document;
          var node = RegExp.$2 ? document.getElementById(RegExp.$3) : document.getElementsByName(RegExp.$3)[0] || null;
          if (node && "value" in node) {
            node.value = decodeURI(RegExp.$4);
            
            var event = document.createEvent("UIEvents");
            event.initUIEvent("input", true, true, aContent, 0);
            node.dispatchEvent(event);
          }
        }
      });
    }
    
    function restoreTextDataAndScrolling(aContent, aData, aPrefix) {
      restoreTextData(aContent, aPrefix);
      if (aData.innerHTML) {
        aContent.setTimeout(function(aHTML) { if (this.document.designMode == "on") { this.document.body.innerHTML = aHTML; } }, 0, aData.innerHTML);
      }
      if (aData.scroll && /(\d+),(\d+)/.test(aData.scroll)) {
        aContent.scrollTo(RegExp.$1, RegExp.$2);
      }
      for (var i = 0; i < aContent.frames.length; i++) {
        if (aData.children && aData.children[i]) {
          restoreTextDataAndScrolling(aContent.frames[i], aData.children[i], i + "|" + aPrefix);
        }
      }
    }
    
    var content = XPCNativeWrapper(aEvent.originalTarget).defaultView;
    if (this.currentURI.spec == "about:config") {
      // unwrap the document for about:config because otherwise the properties
      // of the XBL bindings - as the textbox - aren't accessible (see bug 350718)
      content = content.wrappedJSObject;
    }
    restoreTextDataAndScrolling(content, this.__SS_restore_data, "");
    
    // notify the tabbrowser that this document has been completely restored
    var event = this.ownerDocument.createEvent("Events");
    event.initEvent("SSTabRestored", true, false);
    this.__SS_restore_tab.dispatchEvent(event);
    
    this.removeEventListener("load", this.__SS_restore, true);
    delete this.__SS_restore_data;
    delete this.__SS_restore_text;
    delete this.__SS_restore_tab;
  },
  xulAttributes: [],

  getInterfaces: function TB_getInterfaces(countRef) {
    var interfaces = [Ci.oyITaboo, Ci.nsIObserver, Ci.nsISupports];
    countRef.value = interfaces.length;
    return interfaces;
  },
  getHelperForLanguage: function TB_getHelperForLanguage(language) {
    return null;
  },
  contractID: TB_CONTRACTID,
  classDescription: TB_CLASSNAME,
  classID: TB_CLASSID,
  implementationLanguage: Ci.nsIProgrammingLanguage.JAVASCRIPT,
  flags: Ci.nsIClassInfo.SINGLETON,

  QueryInterface: function TB_QueryInterface(iid) {
    if (iid.equals(Ci.oyITaboo) ||
        iid.equals(Ci.nsIObserver) ||
        iid.equals(Ci.nsISupports))
      return this;
    throw Cr.NS_ERROR_NO_INTERFACE;
  }
}


/* This is swiped from bookmarks.js in Firefox. In Firefox 3, this *should*
 * be easier, and not require cut'n'pasting
 */
function tabooFavIconLoadListener(url, faviconurl, channel, storage) {
  this.mURL = url;
  this.mFavIconURL = faviconurl;
  this.mCountRead = 0;
  this.mChannel = channel;
  this.mStorage = storage;
}

tabooFavIconLoadListener.prototype = {
  mURL : null,
  mFavIconURL : null,
  mCountRead : null,
  mChannel : null,
  mBytes : Array(),
  mStream : null,

  QueryInterface: function (iid) {
    if (!iid.equals(Components.interfaces.nsISupports) &&
        !iid.equals(Components.interfaces.nsIInterfaceRequestor) &&
        !iid.equals(Components.interfaces.nsIRequestObserver) &&
        !iid.equals(Components.interfaces.nsIChannelEventSink) &&
        !iid.equals(Components.interfaces.nsIProgressEventSink) && // see below
        !iid.equals(Components.interfaces.nsIStreamListener)) {
      throw Components.results.NS_ERROR_NO_INTERFACE;
    }
    return this;
  },

  // nsIInterfaceRequestor
  getInterface: function (iid) {
    try {
      return this.QueryInterface(iid);
    } catch (e) {
      throw Components.results.NS_NOINTERFACE;
    }
  },

  // nsIRequestObserver
  onStartRequest : function (aRequest, aContext) {
    this.mStream = Components.classes['@mozilla.org/binaryinputstream;1'].createInstance(Components.interfaces.nsIBinaryInputStream);
  },

  onStopRequest : function (aRequest, aContext, aStatusCode) {
    var httpChannel = this.mChannel.QueryInterface(Components.interfaces.nsIHttpChannel);
    if ((httpChannel && httpChannel.requestSucceeded) &&
        Components.isSuccessCode(aStatusCode) &&
        this.mCountRead > 0)
    {
      var dataurl;
      // XXX - arbitrary size beyond which we won't store a favicon.  This is /extremely/
      // generous, and is probably too high.
      if (this.mCountRead > 16384) {
        dataurl = "data:";      // hack meaning "pretend this doesn't exist"
      } else {
        // get us a mime type for this
        var mimeType = null;

        const nsICategoryManager = Components.interfaces.nsICategoryManager;
        const nsIContentSniffer = Components.interfaces.nsIContentSniffer;

        var catMgr = Components.classes["@mozilla.org/categorymanager;1"].getService(nsICategoryManager);
        var sniffers = catMgr.enumerateCategory("content-sniffing-services");
        while (mimeType == null && sniffers.hasMoreElements()) {
          var snifferCID = sniffers.getNext().QueryInterface(Components.interfaces.nsISupportsCString).toString();
          var sniffer = Components.classes[snifferCID].getService(nsIContentSniffer);

          try {
            mimeType = sniffer.getMIMETypeFromContent (this.mBytes, this.mCountRead);
          } catch (e) {
            mimeType = null;
            // ignore
          }
        }
      }

      if (this.mBytes && this.mCountRead > 0 && mimeType != null) {
        var data = 'data:';
        data += mimeType;
        data += ';base64;';

        var iconData = String.fromCharCode.apply(null, this.mBytes);
        data += base64Encode(iconData);

        this.mStorage.saveFavicon(this.mURL, data);
      }
    }

    this.mChannel = null;
  },

  // nsIStreamObserver
  onDataAvailable : function (aRequest, aContext, aInputStream, aOffset, aCount) {
    // we could get a different aInputStream, so we don't save this;
    // it's unlikely we'll get more than one onDataAvailable for a
    // favicon anyway
    this.mStream.setInputStream(aInputStream);

    var chunk = this.mStream.readByteArray(aCount);
    this.mBytes = this.mBytes.concat(chunk);
    this.mCountRead += aCount;
  },

  // nsIChannelEventSink
  onChannelRedirect : function (aOldChannel, aNewChannel, aFlags) {
    this.mChannel = aNewChannel;
  },

  // nsIProgressEventSink: the only reason we support
  // nsIProgressEventSink is to shut up a whole slew of xpconnect
  // warnings in debug builds.  (see bug #253127)
  onProgress : function (aRequest, aContext, aProgress, aProgressMax) { },
  onStatus : function (aRequest, aContext, aStatus, aStatusArg) { }
}

// From flockFavoritesService.js
function base64Encode(aInput) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  var output = "";
  while (aInput.length > 0) {
    output += chars[aInput.charCodeAt(0) >> 2];
    output += chars[((aInput.charCodeAt(0) & 0x03) << 4) |
      (aInput.length > 1 ? ((aInput.charCodeAt(1) & 0xF0) >> 4) : 0)];
    output += chars[aInput.length > 1 ?
      ((aInput.charCodeAt(1) & 0x0F) << 2) |
      (aInput.length > 2 ? ((aInput.charCodeAt(2) & 0xC0) >> 6) : 0) : 64];
    output += chars[aInput.length > 2 ?
      (aInput.charCodeAt(2) & 0x3F) : 64];
    if (aInput.length > 3) {
      aInput = aInput.substr(3);
    } else {
      break;
    }
  }
  return output;
}


function GenericComponentFactory(ctor) {
  this._ctor = ctor;
}

GenericComponentFactory.prototype = {

  _ctor: null,

  // nsIFactory
  createInstance: function(outer, iid) {
    if (outer != null)
      throw Cr.NS_ERROR_NO_AGGREGATION;
    return (new this._ctor()).QueryInterface(iid);
  },

  // nsISupports
  QueryInterface: function(iid) {
    if (iid.equals(Ci.nsIFactory) ||
        iid.equals(Ci.nsISupports))
      return this;
    throw Cr.NS_ERROR_NO_INTERFACE;
  },
};

var Module = {
  QueryInterface: function(iid) {
    if (iid.equals(Ci.nsIModule) ||
        iid.equals(Ci.nsISupports))
      return this;

    throw Cr.NS_ERROR_NO_INTERFACE;
  },

  getClassObject: function(cm, cid, iid) {
    if (!iid.equals(Ci.nsIFactory))
      throw Cr.NS_ERROR_NOT_IMPLEMENTED;

    if (cid.equals(TB_CLASSID))
      return new GenericComponentFactory(TabooService)

    throw Cr.NS_ERROR_NO_INTERFACE;
  },

  registerSelf: function(cm, file, location, type) {
    var cr = cm.QueryInterface(Ci.nsIComponentRegistrar);
    cr.registerFactoryLocation(TB_CLASSID, TB_CLASSNAME, TB_CONTRACTID,
                               file, location, type);

    var catman = Cc['@mozilla.org/categorymanager;1']
      .getService(Ci.nsICategoryManager);
    catman.addCategoryEntry('app-startup', TB_CLASSNAME,
                            'service,' + TB_CONTRACTID,
                            true, true);
  },

  unregisterSelf: function(cm, location, type) {
    var cr = cm.QueryInterface(Ci.nsIComponentRegistrar);
    cr.unregisterFactoryLocation(TB_CLASSID, location);
  },

  canUnload: function(cm) {
    return true;
  },
};

function NSGetModule(compMgr, fileSpec)
{
  return Module;
}


function loadSubScript(spec) {
  var loader = Cc['@mozilla.org/moz/jssubscript-loader;1']
    .getService(Ci.mozIJSSubScriptLoader);
  var context = {};
  loader.loadSubScript(spec, context);
  return context;
}
