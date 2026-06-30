import {
  cssClassesToArray,
  getActiveElementAnimations,
  provideCustomClassSettableExisting,
  provideExposesStateProviderExisting,
  waitForAnimations
} from "./chunk-MAJBEXLM.js";
import {
  ALT,
  BasePortalOutlet,
  CONTROL,
  CdkPortalOutlet,
  ComponentPortal,
  Directionality,
  ESCAPE,
  MAC_META,
  META,
  OverlayConfig,
  OverlayContainer,
  OverlayModule,
  OverlayOutsideClickDispatcher,
  OverlayPositionBuilder,
  OverlayRef,
  Platform,
  PortalModule,
  SHIFT,
  ScrollStrategyOptions,
  TemplatePortal,
  _CdkPrivateStyleLoader,
  _IdGenerator,
  _getEventTarget,
  _getFocusedElementPierceShadowDom,
  _getShadowRoot,
  coerceArray,
  coerceElement,
  coerceNumberProperty,
  createBlockScrollStrategy,
  createGlobalPositionStrategy,
  createOverlayRef,
  hasModifierKey
} from "./chunk-JGRVC4C7.js";
import {
  DomSanitizer
} from "./chunk-QOAZVKZ4.js";
import {
  takeUntilDestroyed
} from "./chunk-R6W3E7W4.js";
import {
  BehaviorSubject,
  CSP_NONCE,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DOCUMENT,
  DestroyRef,
  Directive,
  ElementRef,
  EventEmitter,
  Injectable,
  InjectionToken,
  Injector,
  Input,
  NgModule,
  NgZone,
  Observable,
  Output,
  Renderer2,
  RendererFactory2,
  ReplaySubject,
  SecurityContext,
  Service,
  Subject,
  TemplateRef,
  ViewChild,
  ViewContainerRef,
  ViewEncapsulation,
  afterNextRender,
  booleanAttribute,
  combineLatest,
  computed,
  concat,
  debounceTime,
  defer,
  distinctUntilChanged,
  effect,
  filter,
  inject,
  input,
  map,
  of,
  output,
  setClassMetadata,
  signal,
  skip,
  startWith,
  take,
  takeUntil,
  untracked,
  ɵɵInheritDefinitionFeature,
  ɵɵNgOnChangesFeature,
  ɵɵProvidersFeature,
  ɵɵattribute,
  ɵɵdefineComponent,
  ɵɵdefineDirective,
  ɵɵdefineInjectable,
  ɵɵdefineInjector,
  ɵɵdefineNgModule,
  ɵɵdefineService,
  ɵɵdomProperty,
  ɵɵlistener,
  ɵɵloadQuery,
  ɵɵqueryRefresh,
  ɵɵtemplate,
  ɵɵviewQuery
} from "./chunk-55R2KRJF.js";
import {
  __spreadProps,
  __spreadValues
} from "./chunk-GOMI4DH3.js";

// node_modules/@angular/cdk/fesm2022/_fake-event-detection-chunk.mjs
function isFakeMousedownFromScreenReader(event) {
  return event.buttons === 0 || event.detail === 0;
}
function isFakeTouchstartFromScreenReader(event) {
  const touch = event.touches && event.touches[0] || event.changedTouches && event.changedTouches[0];
  return !!touch && touch.identifier === -1 && (touch.radiusX == null || touch.radiusX === 1) && (touch.radiusY == null || touch.radiusY === 1);
}

// node_modules/@angular/cdk/fesm2022/_passive-listeners-chunk.mjs
var supportsPassiveEvents;
function supportsPassiveEventListeners() {
  if (supportsPassiveEvents == null && typeof window !== "undefined") {
    try {
      window.addEventListener("test", null, Object.defineProperty({}, "passive", {
        get: () => supportsPassiveEvents = true
      }));
    } finally {
      supportsPassiveEvents = supportsPassiveEvents || false;
    }
  }
  return supportsPassiveEvents;
}
function normalizePassiveListenerOptions(options) {
  return supportsPassiveEventListeners() ? options : !!options.capture;
}

// node_modules/@angular/cdk/fesm2022/_focus-monitor-chunk.mjs
var INPUT_MODALITY_DETECTOR_OPTIONS = new InjectionToken("cdk-input-modality-detector-options");
var INPUT_MODALITY_DETECTOR_DEFAULT_OPTIONS = {
  ignoreKeys: [ALT, CONTROL, MAC_META, META, SHIFT]
};
var TOUCH_BUFFER_MS = 650;
var modalityEventListenerOptions = {
  passive: true,
  capture: true
};
var InputModalityDetector = class _InputModalityDetector {
  _platform = inject(Platform);
  _listenerCleanups;
  modalityDetected;
  modalityChanged;
  get mostRecentModality() {
    return this._modality.value;
  }
  _mostRecentTarget = null;
  _modality = new BehaviorSubject(null);
  _options;
  _lastTouchMs = 0;
  _onKeydown = (event) => {
    if (this._options?.ignoreKeys?.some((keyCode) => keyCode === event.keyCode)) {
      return;
    }
    this._modality.next("keyboard");
    this._mostRecentTarget = _getEventTarget(event);
  };
  _onMousedown = (event) => {
    if (Date.now() - this._lastTouchMs < TOUCH_BUFFER_MS) {
      return;
    }
    this._modality.next(isFakeMousedownFromScreenReader(event) ? "keyboard" : "mouse");
    this._mostRecentTarget = _getEventTarget(event);
  };
  _onTouchstart = (event) => {
    if (isFakeTouchstartFromScreenReader(event)) {
      this._modality.next("keyboard");
      return;
    }
    this._lastTouchMs = Date.now();
    this._modality.next("touch");
    this._mostRecentTarget = _getEventTarget(event);
  };
  constructor() {
    const ngZone = inject(NgZone);
    const document2 = inject(DOCUMENT);
    const options = inject(INPUT_MODALITY_DETECTOR_OPTIONS, {
      optional: true
    });
    this._options = __spreadValues(__spreadValues({}, INPUT_MODALITY_DETECTOR_DEFAULT_OPTIONS), options);
    this.modalityDetected = this._modality.pipe(skip(1));
    this.modalityChanged = this.modalityDetected.pipe(distinctUntilChanged());
    if (this._platform.isBrowser) {
      const renderer = inject(RendererFactory2).createRenderer(null, null);
      this._listenerCleanups = ngZone.runOutsideAngular(() => {
        return [renderer.listen(document2, "keydown", this._onKeydown, modalityEventListenerOptions), renderer.listen(document2, "mousedown", this._onMousedown, modalityEventListenerOptions), renderer.listen(document2, "touchstart", this._onTouchstart, modalityEventListenerOptions)];
      });
    }
  }
  ngOnDestroy() {
    this._modality.complete();
    this._listenerCleanups?.forEach((cleanup) => cleanup());
  }
  static ɵfac = function InputModalityDetector_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _InputModalityDetector)();
  };
  static ɵprov = ɵɵdefineService({
    token: _InputModalityDetector,
    factory: _InputModalityDetector.ɵfac
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(InputModalityDetector, [{
    type: Service
  }], () => [], null);
})();
var FocusMonitorDetectionMode;
(function(FocusMonitorDetectionMode2) {
  FocusMonitorDetectionMode2[FocusMonitorDetectionMode2["IMMEDIATE"] = 0] = "IMMEDIATE";
  FocusMonitorDetectionMode2[FocusMonitorDetectionMode2["EVENTUAL"] = 1] = "EVENTUAL";
})(FocusMonitorDetectionMode || (FocusMonitorDetectionMode = {}));
var FOCUS_MONITOR_DEFAULT_OPTIONS = new InjectionToken("cdk-focus-monitor-default-options");
var captureEventListenerOptions = normalizePassiveListenerOptions({
  passive: true,
  capture: true
});
var FocusMonitor = class _FocusMonitor {
  _ngZone = inject(NgZone);
  _platform = inject(Platform);
  _inputModalityDetector = inject(InputModalityDetector);
  _origin = null;
  _lastFocusOrigin = null;
  _windowFocused = false;
  _windowFocusTimeoutId;
  _originTimeoutId;
  _originFromTouchInteraction = false;
  _elementInfo = /* @__PURE__ */ new Map();
  _monitoredElementCount = 0;
  _rootNodeFocusListenerCount = /* @__PURE__ */ new Map();
  _detectionMode;
  _windowFocusListener = () => {
    this._windowFocused = true;
    this._windowFocusTimeoutId = setTimeout(() => this._windowFocused = false);
  };
  _document = inject(DOCUMENT);
  _stopInputModalityDetector = new Subject();
  constructor() {
    const options = inject(FOCUS_MONITOR_DEFAULT_OPTIONS, {
      optional: true
    });
    this._detectionMode = options?.detectionMode || FocusMonitorDetectionMode.IMMEDIATE;
  }
  _rootNodeFocusAndBlurListener = (event) => {
    const target = _getEventTarget(event);
    for (let element = target; element; element = element.parentElement) {
      if (event.type === "focus") {
        this._onFocus(event, element);
      } else {
        this._onBlur(event, element);
      }
    }
  };
  monitor(element, checkChildren = false) {
    const nativeElement = coerceElement(element);
    if (!this._platform.isBrowser || nativeElement.nodeType !== 1) {
      return of();
    }
    const rootNode = _getShadowRoot(nativeElement) || this._document;
    const cachedInfo = this._elementInfo.get(nativeElement);
    if (cachedInfo) {
      if (checkChildren) {
        cachedInfo.checkChildren = true;
      }
      return cachedInfo.subject;
    }
    const info = {
      checkChildren,
      subject: new Subject(),
      rootNode
    };
    this._elementInfo.set(nativeElement, info);
    this._registerGlobalListeners(info);
    return info.subject;
  }
  stopMonitoring(element) {
    const nativeElement = coerceElement(element);
    const elementInfo = this._elementInfo.get(nativeElement);
    if (elementInfo) {
      elementInfo.subject.complete();
      this._setClasses(nativeElement);
      this._elementInfo.delete(nativeElement);
      this._removeGlobalListeners(elementInfo);
    }
  }
  focusVia(element, origin, options) {
    const nativeElement = coerceElement(element);
    const focusedElement = this._document.activeElement;
    if (nativeElement === focusedElement) {
      this._getClosestElementsInfo(nativeElement).forEach(([currentElement, info]) => this._originChanged(currentElement, origin, info));
    } else {
      this._setOrigin(origin);
      if (typeof nativeElement.focus === "function") {
        nativeElement.focus(options);
      }
    }
  }
  ngOnDestroy() {
    this._elementInfo.forEach((_info, element) => this.stopMonitoring(element));
  }
  _getWindow() {
    return this._document.defaultView || window;
  }
  _getFocusOrigin(focusEventTarget) {
    if (this._origin) {
      if (this._originFromTouchInteraction) {
        return this._shouldBeAttributedToTouch(focusEventTarget) ? "touch" : "program";
      } else {
        return this._origin;
      }
    }
    if (this._windowFocused && this._lastFocusOrigin) {
      return this._lastFocusOrigin;
    }
    if (focusEventTarget && this._isLastInteractionFromInputLabel(focusEventTarget)) {
      return "mouse";
    }
    return "program";
  }
  _shouldBeAttributedToTouch(focusEventTarget) {
    return this._detectionMode === FocusMonitorDetectionMode.EVENTUAL || !!focusEventTarget?.contains(this._inputModalityDetector._mostRecentTarget);
  }
  _setClasses(element, origin) {
    element.classList.toggle("cdk-focused", !!origin);
    element.classList.toggle("cdk-touch-focused", origin === "touch");
    element.classList.toggle("cdk-keyboard-focused", origin === "keyboard");
    element.classList.toggle("cdk-mouse-focused", origin === "mouse");
    element.classList.toggle("cdk-program-focused", origin === "program");
  }
  _setOrigin(origin, isFromInteraction = false) {
    this._ngZone.runOutsideAngular(() => {
      this._origin = origin;
      this._originFromTouchInteraction = origin === "touch" && isFromInteraction;
      if (this._detectionMode === FocusMonitorDetectionMode.IMMEDIATE) {
        clearTimeout(this._originTimeoutId);
        const ms = this._originFromTouchInteraction ? TOUCH_BUFFER_MS : 1;
        this._originTimeoutId = setTimeout(() => this._origin = null, ms);
      }
    });
  }
  _onFocus(event, element) {
    const elementInfo = this._elementInfo.get(element);
    const focusEventTarget = _getEventTarget(event);
    if (!elementInfo || !elementInfo.checkChildren && element !== focusEventTarget) {
      return;
    }
    this._originChanged(element, this._getFocusOrigin(focusEventTarget), elementInfo);
  }
  _onBlur(event, element) {
    const elementInfo = this._elementInfo.get(element);
    if (!elementInfo || elementInfo.checkChildren && event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) {
      return;
    }
    this._setClasses(element);
    this._emitOrigin(elementInfo, null);
  }
  _emitOrigin(info, origin) {
    if (info.subject.observers.length) {
      this._ngZone.run(() => info.subject.next(origin));
    }
  }
  _registerGlobalListeners(elementInfo) {
    if (!this._platform.isBrowser) {
      return;
    }
    const rootNode = elementInfo.rootNode;
    const rootNodeFocusListeners = this._rootNodeFocusListenerCount.get(rootNode) || 0;
    if (!rootNodeFocusListeners) {
      this._ngZone.runOutsideAngular(() => {
        rootNode.addEventListener("focus", this._rootNodeFocusAndBlurListener, captureEventListenerOptions);
        rootNode.addEventListener("blur", this._rootNodeFocusAndBlurListener, captureEventListenerOptions);
      });
    }
    this._rootNodeFocusListenerCount.set(rootNode, rootNodeFocusListeners + 1);
    if (++this._monitoredElementCount === 1) {
      this._ngZone.runOutsideAngular(() => {
        const window2 = this._getWindow();
        window2.addEventListener("focus", this._windowFocusListener);
      });
      this._inputModalityDetector.modalityDetected.pipe(takeUntil(this._stopInputModalityDetector)).subscribe((modality) => {
        this._setOrigin(modality, true);
      });
    }
  }
  _removeGlobalListeners(elementInfo) {
    const rootNode = elementInfo.rootNode;
    if (this._rootNodeFocusListenerCount.has(rootNode)) {
      const rootNodeFocusListeners = this._rootNodeFocusListenerCount.get(rootNode);
      if (rootNodeFocusListeners > 1) {
        this._rootNodeFocusListenerCount.set(rootNode, rootNodeFocusListeners - 1);
      } else {
        rootNode.removeEventListener("focus", this._rootNodeFocusAndBlurListener, captureEventListenerOptions);
        rootNode.removeEventListener("blur", this._rootNodeFocusAndBlurListener, captureEventListenerOptions);
        this._rootNodeFocusListenerCount.delete(rootNode);
      }
    }
    if (!--this._monitoredElementCount) {
      const window2 = this._getWindow();
      window2.removeEventListener("focus", this._windowFocusListener);
      this._stopInputModalityDetector.next();
      clearTimeout(this._windowFocusTimeoutId);
      clearTimeout(this._originTimeoutId);
    }
  }
  _originChanged(element, origin, elementInfo) {
    this._setClasses(element, origin);
    this._emitOrigin(elementInfo, origin);
    this._lastFocusOrigin = origin;
  }
  _getClosestElementsInfo(element) {
    const results = [];
    this._elementInfo.forEach((info, currentElement) => {
      if (currentElement === element || info.checkChildren && currentElement.contains(element)) {
        results.push([currentElement, info]);
      }
    });
    return results;
  }
  _isLastInteractionFromInputLabel(focusEventTarget) {
    const {
      _mostRecentTarget: mostRecentTarget,
      mostRecentModality
    } = this._inputModalityDetector;
    if (mostRecentModality !== "mouse" || !mostRecentTarget || mostRecentTarget === focusEventTarget || focusEventTarget.nodeName !== "INPUT" && focusEventTarget.nodeName !== "TEXTAREA" || focusEventTarget.disabled) {
      return false;
    }
    const labels = focusEventTarget.labels;
    if (labels) {
      for (let i = 0; i < labels.length; i++) {
        if (labels[i].contains(mostRecentTarget)) {
          return true;
        }
      }
    }
    return false;
  }
  static ɵfac = function FocusMonitor_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _FocusMonitor)();
  };
  static ɵprov = ɵɵdefineService({
    token: _FocusMonitor,
    factory: _FocusMonitor.ɵfac
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(FocusMonitor, [{
    type: Service
  }], () => [], null);
})();
var CdkMonitorFocus = class _CdkMonitorFocus {
  _elementRef = inject(ElementRef);
  _focusMonitor = inject(FocusMonitor);
  _monitorSubscription;
  _focusOrigin = null;
  cdkFocusChange = new EventEmitter();
  get focusOrigin() {
    return this._focusOrigin;
  }
  ngAfterViewInit() {
    const element = this._elementRef.nativeElement;
    this._monitorSubscription = this._focusMonitor.monitor(element, element.nodeType === 1 && element.hasAttribute("cdkMonitorSubtreeFocus")).subscribe((origin) => {
      this._focusOrigin = origin;
      this.cdkFocusChange.emit(origin);
    });
  }
  ngOnDestroy() {
    this._focusMonitor.stopMonitoring(this._elementRef);
    this._monitorSubscription?.unsubscribe();
  }
  static ɵfac = function CdkMonitorFocus_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _CdkMonitorFocus)();
  };
  static ɵdir = ɵɵdefineDirective({
    type: _CdkMonitorFocus,
    selectors: [["", "cdkMonitorElementFocus", ""], ["", "cdkMonitorSubtreeFocus", ""]],
    outputs: {
      cdkFocusChange: "cdkFocusChange"
    },
    exportAs: ["cdkMonitorFocus"]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(CdkMonitorFocus, [{
    type: Directive,
    args: [{
      selector: "[cdkMonitorElementFocus], [cdkMonitorSubtreeFocus]",
      exportAs: "cdkMonitorFocus"
    }]
  }], null, {
    cdkFocusChange: [{
      type: Output
    }]
  });
})();

// node_modules/@angular/cdk/fesm2022/private.mjs
var _VisuallyHiddenLoader = class __VisuallyHiddenLoader {
  static ɵfac = function _VisuallyHiddenLoader_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || __VisuallyHiddenLoader)();
  };
  static ɵcmp = ɵɵdefineComponent({
    type: __VisuallyHiddenLoader,
    selectors: [["ng-component"]],
    exportAs: ["cdkVisuallyHidden"],
    decls: 0,
    vars: 0,
    template: function _VisuallyHiddenLoader_Template(rf, ctx) {
    },
    styles: [".cdk-visually-hidden {\n  border: 0;\n  clip: rect(0 0 0 0);\n  height: 1px;\n  margin: -1px;\n  overflow: hidden;\n  padding: 0;\n  position: absolute;\n  width: 1px;\n  white-space: nowrap;\n  outline: 0;\n  -webkit-appearance: none;\n  -moz-appearance: none;\n  left: 0;\n}\n[dir=rtl] .cdk-visually-hidden {\n  left: auto;\n  right: 0;\n}\n"],
    encapsulation: 2
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(_VisuallyHiddenLoader, [{
    type: Component,
    args: [{
      exportAs: "cdkVisuallyHidden",
      encapsulation: ViewEncapsulation.None,
      template: "",
      styles: [".cdk-visually-hidden {\n  border: 0;\n  clip: rect(0 0 0 0);\n  height: 1px;\n  margin: -1px;\n  overflow: hidden;\n  padding: 0;\n  position: absolute;\n  width: 1px;\n  white-space: nowrap;\n  outline: 0;\n  -webkit-appearance: none;\n  -moz-appearance: none;\n  left: 0;\n}\n[dir=rtl] .cdk-visually-hidden {\n  left: auto;\n  right: 0;\n}\n"]
    }]
  }], null, null);
})();
var policy;
function getPolicy() {
  if (policy === void 0) {
    policy = null;
    if (typeof window !== "undefined") {
      const ttWindow = window;
      if (ttWindow.trustedTypes !== void 0) {
        policy = ttWindow.trustedTypes.createPolicy("angular#components", {
          createHTML: (s) => s
        });
      }
    }
  }
  return policy;
}
function trustedHTMLFromString(html) {
  return getPolicy()?.createHTML(html) || html;
}
function _setInnerHtml(element, html, sanitizer) {
  const cleanHtml = sanitizer.sanitize(SecurityContext.HTML, html);
  if (cleanHtml === null && (typeof ngDevMode === "undefined" || ngDevMode)) {
    throw new Error(`Could not sanitize HTML: ${html}`);
  }
  element.innerHTML = trustedHTMLFromString(cleanHtml || "");
}

// node_modules/@angular/cdk/fesm2022/_breakpoints-observer-chunk.mjs
var mediaQueriesForWebkitCompatibility = /* @__PURE__ */ new Set();
var mediaQueryStyleNode;
var MediaMatcher = class _MediaMatcher {
  _platform = inject(Platform);
  _nonce = inject(CSP_NONCE, {
    optional: true
  });
  _matchMedia;
  constructor() {
    this._matchMedia = this._platform.isBrowser && window.matchMedia ? window.matchMedia.bind(window) : noopMatchMedia;
  }
  matchMedia(query) {
    if (this._platform.WEBKIT || this._platform.BLINK) {
      createEmptyStyleRule(query, this._nonce);
    }
    return this._matchMedia(query);
  }
  static ɵfac = function MediaMatcher_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _MediaMatcher)();
  };
  static ɵprov = ɵɵdefineService({
    token: _MediaMatcher,
    factory: _MediaMatcher.ɵfac
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(MediaMatcher, [{
    type: Service
  }], () => [], null);
})();
function createEmptyStyleRule(query, nonce) {
  if (mediaQueriesForWebkitCompatibility.has(query)) {
    return;
  }
  try {
    if (!mediaQueryStyleNode) {
      mediaQueryStyleNode = document.createElement("style");
      if (nonce) {
        mediaQueryStyleNode.setAttribute("nonce", nonce);
      }
      mediaQueryStyleNode.setAttribute("type", "text/css");
      document.head.appendChild(mediaQueryStyleNode);
    }
    if (mediaQueryStyleNode.sheet) {
      mediaQueryStyleNode.sheet.insertRule(`@media ${query.replace(/[{}]/g, "")} {body{ }}`, 0);
      mediaQueriesForWebkitCompatibility.add(query);
    }
  } catch (e) {
    console.error(e);
  }
}
function noopMatchMedia(query) {
  return {
    matches: query === "all" || query === "",
    media: query,
    addListener: () => {
    },
    removeListener: () => {
    }
  };
}
var BreakpointObserver = class _BreakpointObserver {
  _mediaMatcher = inject(MediaMatcher);
  _zone = inject(NgZone);
  _queries = /* @__PURE__ */ new Map();
  _destroySubject = new Subject();
  ngOnDestroy() {
    this._destroySubject.next();
    this._destroySubject.complete();
  }
  isMatched(value) {
    const queries = splitQueries(coerceArray(value));
    return queries.some((mediaQuery) => this._registerQuery(mediaQuery).mql.matches);
  }
  observe(value) {
    const queries = splitQueries(coerceArray(value));
    const observables = queries.map((query) => this._registerQuery(query).observable);
    let stateObservable = combineLatest(observables);
    stateObservable = concat(stateObservable.pipe(take(1)), stateObservable.pipe(skip(1), debounceTime(0)));
    return stateObservable.pipe(map((breakpointStates) => {
      const response = {
        matches: false,
        breakpoints: {}
      };
      breakpointStates.forEach(({
        matches,
        query
      }) => {
        response.matches = response.matches || matches;
        response.breakpoints[query] = matches;
      });
      return response;
    }));
  }
  _registerQuery(query) {
    if (this._queries.has(query)) {
      return this._queries.get(query);
    }
    const mql = this._mediaMatcher.matchMedia(query);
    const queryObservable = new Observable((observer) => {
      const handler = (e) => this._zone.run(() => observer.next(e));
      mql.addListener(handler);
      return () => {
        mql.removeListener(handler);
      };
    }).pipe(startWith(mql), map(({
      matches
    }) => ({
      query,
      matches
    })), takeUntil(this._destroySubject));
    const output2 = {
      observable: queryObservable,
      mql
    };
    this._queries.set(query, output2);
    return output2;
  }
  static ɵfac = function BreakpointObserver_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _BreakpointObserver)();
  };
  static ɵprov = ɵɵdefineService({
    token: _BreakpointObserver,
    factory: _BreakpointObserver.ɵfac
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BreakpointObserver, [{
    type: Service
  }], null, null);
})();
function splitQueries(queries) {
  return queries.map((query) => query.split(",")).reduce((a1, a2) => a1.concat(a2)).map((query) => query.trim());
}

// node_modules/@angular/cdk/fesm2022/observers.mjs
function shouldIgnoreRecord(record) {
  if (record.type === "characterData" && record.target instanceof Comment) {
    return true;
  }
  if (record.type === "childList") {
    for (let i = 0; i < record.addedNodes.length; i++) {
      if (!(record.addedNodes[i] instanceof Comment)) {
        return false;
      }
    }
    for (let i = 0; i < record.removedNodes.length; i++) {
      if (!(record.removedNodes[i] instanceof Comment)) {
        return false;
      }
    }
    return true;
  }
  return false;
}
var MutationObserverFactory = class _MutationObserverFactory {
  create(callback) {
    return typeof MutationObserver === "undefined" ? null : new MutationObserver(callback);
  }
  static ɵfac = function MutationObserverFactory_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _MutationObserverFactory)();
  };
  static ɵprov = ɵɵdefineService({
    token: _MutationObserverFactory,
    factory: _MutationObserverFactory.ɵfac
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(MutationObserverFactory, [{
    type: Service
  }], null, null);
})();
var ContentObserver = class _ContentObserver {
  _mutationObserverFactory = inject(MutationObserverFactory);
  _observedElements = /* @__PURE__ */ new Map();
  _ngZone = inject(NgZone);
  ngOnDestroy() {
    this._observedElements.forEach((_, element) => this._cleanupObserver(element));
  }
  observe(elementOrRef) {
    const element = coerceElement(elementOrRef);
    return new Observable((observer) => {
      const stream = this._observeElement(element);
      const subscription = stream.pipe(map((records) => records.filter((record) => !shouldIgnoreRecord(record))), filter((records) => !!records.length)).subscribe((records) => {
        this._ngZone.run(() => {
          observer.next(records);
        });
      });
      return () => {
        subscription.unsubscribe();
        this._unobserveElement(element);
      };
    });
  }
  _observeElement(element) {
    return this._ngZone.runOutsideAngular(() => {
      if (!this._observedElements.has(element)) {
        const stream = new Subject();
        const observer = this._mutationObserverFactory.create((mutations) => stream.next(mutations));
        if (observer) {
          observer.observe(element, {
            characterData: true,
            childList: true,
            subtree: true
          });
        }
        this._observedElements.set(element, {
          observer,
          stream,
          count: 1
        });
      } else {
        this._observedElements.get(element).count++;
      }
      return this._observedElements.get(element).stream;
    });
  }
  _unobserveElement(element) {
    if (this._observedElements.has(element)) {
      this._observedElements.get(element).count--;
      if (!this._observedElements.get(element).count) {
        this._cleanupObserver(element);
      }
    }
  }
  _cleanupObserver(element) {
    if (this._observedElements.has(element)) {
      const {
        observer,
        stream
      } = this._observedElements.get(element);
      if (observer) {
        observer.disconnect();
      }
      stream.complete();
      this._observedElements.delete(element);
    }
  }
  static ɵfac = function ContentObserver_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _ContentObserver)();
  };
  static ɵprov = ɵɵdefineService({
    token: _ContentObserver,
    factory: _ContentObserver.ɵfac
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(ContentObserver, [{
    type: Service
  }], null, null);
})();
var CdkObserveContent = class _CdkObserveContent {
  _contentObserver = inject(ContentObserver);
  _elementRef = inject(ElementRef);
  event = new EventEmitter();
  get disabled() {
    return this._disabled;
  }
  set disabled(value) {
    this._disabled = value;
    this._disabled ? this._unsubscribe() : this._subscribe();
  }
  _disabled = false;
  get debounce() {
    return this._debounce;
  }
  set debounce(value) {
    this._debounce = coerceNumberProperty(value);
    this._subscribe();
  }
  _debounce;
  _currentSubscription = null;
  ngAfterContentInit() {
    if (!this._currentSubscription && !this.disabled) {
      this._subscribe();
    }
  }
  ngOnDestroy() {
    this._unsubscribe();
  }
  _subscribe() {
    this._unsubscribe();
    const stream = this._contentObserver.observe(this._elementRef);
    this._currentSubscription = (this.debounce ? stream.pipe(debounceTime(this.debounce)) : stream).subscribe(this.event);
  }
  _unsubscribe() {
    this._currentSubscription?.unsubscribe();
  }
  static ɵfac = function CdkObserveContent_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _CdkObserveContent)();
  };
  static ɵdir = ɵɵdefineDirective({
    type: _CdkObserveContent,
    selectors: [["", "cdkObserveContent", ""]],
    inputs: {
      disabled: [2, "cdkObserveContentDisabled", "disabled", booleanAttribute],
      debounce: "debounce"
    },
    outputs: {
      event: "cdkObserveContent"
    },
    exportAs: ["cdkObserveContent"]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(CdkObserveContent, [{
    type: Directive,
    args: [{
      selector: "[cdkObserveContent]",
      exportAs: "cdkObserveContent"
    }]
  }], null, {
    event: [{
      type: Output,
      args: ["cdkObserveContent"]
    }],
    disabled: [{
      type: Input,
      args: [{
        alias: "cdkObserveContentDisabled",
        transform: booleanAttribute
      }]
    }],
    debounce: [{
      type: Input
    }]
  });
})();
var ObserversModule = class _ObserversModule {
  static ɵfac = function ObserversModule_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _ObserversModule)();
  };
  static ɵmod = ɵɵdefineNgModule({
    type: _ObserversModule,
    imports: [CdkObserveContent],
    exports: [CdkObserveContent]
  });
  static ɵinj = ɵɵdefineInjector({
    providers: [MutationObserverFactory]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(ObserversModule, [{
    type: NgModule,
    args: [{
      imports: [CdkObserveContent],
      exports: [CdkObserveContent],
      providers: [MutationObserverFactory]
    }]
  }], null, null);
})();

// node_modules/@angular/cdk/fesm2022/_a11y-module-chunk.mjs
var InteractivityChecker = class _InteractivityChecker {
  _platform = inject(Platform);
  isDisabled(element) {
    return element.hasAttribute("disabled");
  }
  isVisible(element) {
    return hasGeometry(element) && getComputedStyle(element).visibility === "visible";
  }
  isTabbable(element) {
    if (!this._platform.isBrowser) {
      return false;
    }
    const frameElement = getFrameElement(getWindow(element));
    if (frameElement) {
      if (getTabIndexValue(frameElement) === -1) {
        return false;
      }
      if (!this.isVisible(frameElement)) {
        return false;
      }
    }
    let nodeName = element.nodeName.toLowerCase();
    let tabIndexValue = getTabIndexValue(element);
    if (element.hasAttribute("contenteditable")) {
      return tabIndexValue !== -1;
    }
    if (nodeName === "iframe" || nodeName === "object") {
      return false;
    }
    if (this._platform.WEBKIT && this._platform.IOS && !isPotentiallyTabbableIOS(element)) {
      return false;
    }
    if (nodeName === "audio") {
      if (!element.hasAttribute("controls")) {
        return false;
      }
      return tabIndexValue !== -1;
    }
    if (nodeName === "video") {
      if (tabIndexValue === -1) {
        return false;
      }
      if (tabIndexValue !== null) {
        return true;
      }
      return this._platform.FIREFOX || element.hasAttribute("controls");
    }
    return element.tabIndex >= 0;
  }
  isFocusable(element, config) {
    return isPotentiallyFocusable(element) && !this.isDisabled(element) && (config?.ignoreVisibility || this.isVisible(element));
  }
  static ɵfac = function InteractivityChecker_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _InteractivityChecker)();
  };
  static ɵprov = ɵɵdefineService({
    token: _InteractivityChecker,
    factory: _InteractivityChecker.ɵfac
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(InteractivityChecker, [{
    type: Service
  }], null, null);
})();
function getFrameElement(window2) {
  try {
    return window2.frameElement;
  } catch {
    return null;
  }
}
function hasGeometry(element) {
  return !!(element.offsetWidth || element.offsetHeight || typeof element.getClientRects === "function" && element.getClientRects().length);
}
function isNativeFormElement(element) {
  let nodeName = element.nodeName.toLowerCase();
  return nodeName === "input" || nodeName === "select" || nodeName === "button" || nodeName === "textarea";
}
function isHiddenInput(element) {
  return isInputElement(element) && element.type == "hidden";
}
function isAnchorWithHref(element) {
  return isAnchorElement(element) && element.hasAttribute("href");
}
function isInputElement(element) {
  return element.nodeName.toLowerCase() == "input";
}
function isAnchorElement(element) {
  return element.nodeName.toLowerCase() == "a";
}
function hasValidTabIndex(element) {
  if (!element.hasAttribute("tabindex") || element.tabIndex === void 0) {
    return false;
  }
  let tabIndex = element.getAttribute("tabindex");
  return !!(tabIndex && !isNaN(parseInt(tabIndex, 10)));
}
function getTabIndexValue(element) {
  if (!hasValidTabIndex(element)) {
    return null;
  }
  const tabIndex = parseInt(element.getAttribute("tabindex") || "", 10);
  return isNaN(tabIndex) ? -1 : tabIndex;
}
function isPotentiallyTabbableIOS(element) {
  let nodeName = element.nodeName.toLowerCase();
  let inputType = nodeName === "input" && element.type;
  return inputType === "text" || inputType === "password" || nodeName === "select" || nodeName === "textarea";
}
function isPotentiallyFocusable(element) {
  if (isHiddenInput(element)) {
    return false;
  }
  return isNativeFormElement(element) || isAnchorWithHref(element) || element.hasAttribute("contenteditable") || hasValidTabIndex(element);
}
function getWindow(node) {
  return node.ownerDocument && node.ownerDocument.defaultView || window;
}
var FocusTrap = class {
  _element;
  _checker;
  _ngZone;
  _document;
  _injector;
  _startAnchor = null;
  _endAnchor = null;
  _hasAttached = false;
  startAnchorListener = () => this.focusLastTabbableElement();
  endAnchorListener = () => this.focusFirstTabbableElement();
  get enabled() {
    return this._enabled;
  }
  set enabled(value) {
    this._enabled = value;
    if (this._startAnchor && this._endAnchor) {
      this._toggleAnchorTabIndex(value, this._startAnchor);
      this._toggleAnchorTabIndex(value, this._endAnchor);
    }
  }
  _enabled = true;
  constructor(_element, _checker, _ngZone, _document, deferAnchors = false, _injector) {
    this._element = _element;
    this._checker = _checker;
    this._ngZone = _ngZone;
    this._document = _document;
    this._injector = _injector;
    if (!deferAnchors) {
      this.attachAnchors();
    }
  }
  destroy() {
    const startAnchor = this._startAnchor;
    const endAnchor = this._endAnchor;
    if (startAnchor) {
      startAnchor.removeEventListener("focus", this.startAnchorListener);
      startAnchor.remove();
    }
    if (endAnchor) {
      endAnchor.removeEventListener("focus", this.endAnchorListener);
      endAnchor.remove();
    }
    this._startAnchor = this._endAnchor = null;
    this._hasAttached = false;
  }
  attachAnchors() {
    if (this._hasAttached) {
      return true;
    }
    this._ngZone.runOutsideAngular(() => {
      if (!this._startAnchor) {
        this._startAnchor = this._createAnchor();
        this._startAnchor.addEventListener("focus", this.startAnchorListener);
      }
      if (!this._endAnchor) {
        this._endAnchor = this._createAnchor();
        this._endAnchor.addEventListener("focus", this.endAnchorListener);
      }
    });
    if (this._element.parentNode) {
      this._element.parentNode.insertBefore(this._startAnchor, this._element);
      this._element.parentNode.insertBefore(this._endAnchor, this._element.nextSibling);
      this._hasAttached = true;
    }
    return this._hasAttached;
  }
  focusInitialElementWhenReady(options) {
    return new Promise((resolve) => {
      this._executeOnStable(() => resolve(this.focusInitialElement(options)));
    });
  }
  focusFirstTabbableElementWhenReady(options) {
    return new Promise((resolve) => {
      this._executeOnStable(() => resolve(this.focusFirstTabbableElement(options)));
    });
  }
  focusLastTabbableElementWhenReady(options) {
    return new Promise((resolve) => {
      this._executeOnStable(() => resolve(this.focusLastTabbableElement(options)));
    });
  }
  _getRegionBoundary(bound) {
    const markers = this._element.querySelectorAll(`[cdk-focus-region-${bound}], [cdkFocusRegion${bound}], [cdk-focus-${bound}]`);
    if (typeof ngDevMode === "undefined" || ngDevMode) {
      for (let i = 0; i < markers.length; i++) {
        if (markers[i].hasAttribute(`cdk-focus-${bound}`)) {
          console.warn(`Found use of deprecated attribute 'cdk-focus-${bound}', use 'cdkFocusRegion${bound}' instead. The deprecated attribute will be removed in 8.0.0.`, markers[i]);
        } else if (markers[i].hasAttribute(`cdk-focus-region-${bound}`)) {
          console.warn(`Found use of deprecated attribute 'cdk-focus-region-${bound}', use 'cdkFocusRegion${bound}' instead. The deprecated attribute will be removed in 8.0.0.`, markers[i]);
        }
      }
    }
    if (bound == "start") {
      return markers.length ? markers[0] : this._getFirstTabbableElement(this._element);
    }
    return markers.length ? markers[markers.length - 1] : this._getLastTabbableElement(this._element);
  }
  focusInitialElement(options) {
    const redirectToElement = this._element.querySelector(`[cdk-focus-initial], [cdkFocusInitial]`);
    if (redirectToElement) {
      if ((typeof ngDevMode === "undefined" || ngDevMode) && redirectToElement.hasAttribute(`cdk-focus-initial`)) {
        console.warn(`Found use of deprecated attribute 'cdk-focus-initial', use 'cdkFocusInitial' instead. The deprecated attribute will be removed in 8.0.0`, redirectToElement);
      }
      if ((typeof ngDevMode === "undefined" || ngDevMode) && !this._checker.isFocusable(redirectToElement)) {
        console.warn(`Element matching '[cdkFocusInitial]' is not focusable.`, redirectToElement);
      }
      if (!this._checker.isFocusable(redirectToElement)) {
        const focusableChild = this._getFirstTabbableElement(redirectToElement);
        focusableChild?.focus(options);
        return !!focusableChild;
      }
      redirectToElement.focus(options);
      return true;
    }
    return this.focusFirstTabbableElement(options);
  }
  focusFirstTabbableElement(options) {
    const redirectToElement = this._getRegionBoundary("start");
    if (redirectToElement) {
      redirectToElement.focus(options);
    }
    return !!redirectToElement;
  }
  focusLastTabbableElement(options) {
    const redirectToElement = this._getRegionBoundary("end");
    if (redirectToElement) {
      redirectToElement.focus(options);
    }
    return !!redirectToElement;
  }
  hasAttached() {
    return this._hasAttached;
  }
  _getFirstTabbableElement(root) {
    if (this._checker.isFocusable(root) && this._checker.isTabbable(root)) {
      return root;
    }
    const children = root.children;
    for (let i = 0; i < children.length; i++) {
      const tabbableChild = children[i].nodeType === this._document.ELEMENT_NODE ? this._getFirstTabbableElement(children[i]) : null;
      if (tabbableChild) {
        return tabbableChild;
      }
    }
    return null;
  }
  _getLastTabbableElement(root) {
    if (this._checker.isFocusable(root) && this._checker.isTabbable(root)) {
      return root;
    }
    const children = root.children;
    for (let i = children.length - 1; i >= 0; i--) {
      const tabbableChild = children[i].nodeType === this._document.ELEMENT_NODE ? this._getLastTabbableElement(children[i]) : null;
      if (tabbableChild) {
        return tabbableChild;
      }
    }
    return null;
  }
  _createAnchor() {
    const anchor = this._document.createElement("div");
    this._toggleAnchorTabIndex(this._enabled, anchor);
    anchor.classList.add("cdk-visually-hidden");
    anchor.classList.add("cdk-focus-trap-anchor");
    anchor.setAttribute("aria-hidden", "true");
    return anchor;
  }
  _toggleAnchorTabIndex(isEnabled, anchor) {
    isEnabled ? anchor.setAttribute("tabindex", "0") : anchor.removeAttribute("tabindex");
  }
  toggleAnchors(enabled) {
    if (this._startAnchor && this._endAnchor) {
      this._toggleAnchorTabIndex(enabled, this._startAnchor);
      this._toggleAnchorTabIndex(enabled, this._endAnchor);
    }
  }
  _executeOnStable(fn) {
    afterNextRender(fn, {
      injector: this._injector
    });
  }
};
var FocusTrapFactory = class _FocusTrapFactory {
  _checker = inject(InteractivityChecker);
  _ngZone = inject(NgZone);
  _document = inject(DOCUMENT);
  _injector = inject(Injector);
  constructor() {
    inject(_CdkPrivateStyleLoader).load(_VisuallyHiddenLoader);
  }
  create(element, deferCaptureElements = false) {
    return new FocusTrap(element, this._checker, this._ngZone, this._document, deferCaptureElements, this._injector);
  }
  static ɵfac = function FocusTrapFactory_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _FocusTrapFactory)();
  };
  static ɵprov = ɵɵdefineService({
    token: _FocusTrapFactory,
    factory: _FocusTrapFactory.ɵfac
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(FocusTrapFactory, [{
    type: Service
  }], () => [], null);
})();
var CdkTrapFocus = class _CdkTrapFocus {
  _elementRef = inject(ElementRef);
  _focusTrapFactory = inject(FocusTrapFactory);
  focusTrap = void 0;
  _previouslyFocusedElement = null;
  get enabled() {
    return this.focusTrap?.enabled || false;
  }
  set enabled(value) {
    if (this.focusTrap) {
      this.focusTrap.enabled = value;
    }
  }
  autoCapture = false;
  constructor() {
    const platform = inject(Platform);
    if (platform.isBrowser) {
      this.focusTrap = this._focusTrapFactory.create(this._elementRef.nativeElement, true);
    }
  }
  ngOnDestroy() {
    this.focusTrap?.destroy();
    if (this._previouslyFocusedElement) {
      this._previouslyFocusedElement.focus();
      this._previouslyFocusedElement = null;
    }
  }
  ngAfterContentInit() {
    this.focusTrap?.attachAnchors();
    if (this.autoCapture) {
      this._captureFocus();
    }
  }
  ngDoCheck() {
    if (this.focusTrap && !this.focusTrap.hasAttached()) {
      this.focusTrap.attachAnchors();
    }
  }
  ngOnChanges(changes) {
    const autoCaptureChange = changes["autoCapture"];
    if (autoCaptureChange && !autoCaptureChange.firstChange && this.autoCapture && this.focusTrap?.hasAttached()) {
      this._captureFocus();
    }
  }
  _captureFocus() {
    this._previouslyFocusedElement = _getFocusedElementPierceShadowDom();
    this.focusTrap?.focusInitialElementWhenReady();
  }
  static ɵfac = function CdkTrapFocus_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _CdkTrapFocus)();
  };
  static ɵdir = ɵɵdefineDirective({
    type: _CdkTrapFocus,
    selectors: [["", "cdkTrapFocus", ""]],
    inputs: {
      enabled: [2, "cdkTrapFocus", "enabled", booleanAttribute],
      autoCapture: [2, "cdkTrapFocusAutoCapture", "autoCapture", booleanAttribute]
    },
    exportAs: ["cdkTrapFocus"],
    features: [ɵɵNgOnChangesFeature]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(CdkTrapFocus, [{
    type: Directive,
    args: [{
      selector: "[cdkTrapFocus]",
      exportAs: "cdkTrapFocus"
    }]
  }], () => [], {
    enabled: [{
      type: Input,
      args: [{
        alias: "cdkTrapFocus",
        transform: booleanAttribute
      }]
    }],
    autoCapture: [{
      type: Input,
      args: [{
        alias: "cdkTrapFocusAutoCapture",
        transform: booleanAttribute
      }]
    }]
  });
})();
var LIVE_ANNOUNCER_ELEMENT_TOKEN = new InjectionToken("liveAnnouncerElement", {
  providedIn: "root",
  factory: () => null
});
var LIVE_ANNOUNCER_DEFAULT_OPTIONS = new InjectionToken("LIVE_ANNOUNCER_DEFAULT_OPTIONS");
var uniqueIds = 0;
var LiveAnnouncer = class _LiveAnnouncer {
  _ngZone = inject(NgZone);
  _defaultOptions = inject(LIVE_ANNOUNCER_DEFAULT_OPTIONS, {
    optional: true
  });
  _liveElement;
  _document = inject(DOCUMENT);
  _sanitizer = inject(DomSanitizer);
  _previousTimeout;
  _currentPromise;
  _currentResolve;
  constructor() {
    const elementToken = inject(LIVE_ANNOUNCER_ELEMENT_TOKEN, {
      optional: true
    });
    this._liveElement = elementToken || this._createLiveElement();
  }
  announce(message, ...args) {
    const defaultOptions2 = this._defaultOptions;
    let politeness;
    let duration;
    if (args.length === 1 && typeof args[0] === "number") {
      duration = args[0];
    } else {
      [politeness, duration] = args;
    }
    this.clear();
    clearTimeout(this._previousTimeout);
    if (!politeness) {
      politeness = defaultOptions2 && defaultOptions2.politeness ? defaultOptions2.politeness : "polite";
    }
    if (duration == null && defaultOptions2) {
      duration = defaultOptions2.duration;
    }
    this._liveElement.setAttribute("aria-live", politeness);
    if (this._liveElement.id) {
      this._exposeAnnouncerToModals(this._liveElement.id);
    }
    return this._ngZone.runOutsideAngular(() => {
      if (!this._currentPromise) {
        this._currentPromise = new Promise((resolve) => this._currentResolve = resolve);
      }
      clearTimeout(this._previousTimeout);
      this._previousTimeout = setTimeout(() => {
        if (!message || typeof message === "string") {
          this._liveElement.textContent = message;
        } else {
          _setInnerHtml(this._liveElement, message, this._sanitizer);
        }
        if (typeof duration === "number") {
          this._previousTimeout = setTimeout(() => this.clear(), duration);
        }
        this._currentResolve?.();
        this._currentPromise = this._currentResolve = void 0;
      }, 100);
      return this._currentPromise;
    });
  }
  clear() {
    if (this._liveElement) {
      this._liveElement.textContent = "";
    }
  }
  ngOnDestroy() {
    clearTimeout(this._previousTimeout);
    this._liveElement?.remove();
    this._liveElement = null;
    this._currentResolve?.();
    this._currentPromise = this._currentResolve = void 0;
  }
  _createLiveElement() {
    const elementClass = "cdk-live-announcer-element";
    const previousElements = this._document.getElementsByClassName(elementClass);
    const liveEl = this._document.createElement("div");
    for (let i = 0; i < previousElements.length; i++) {
      previousElements[i].remove();
    }
    liveEl.classList.add(elementClass);
    liveEl.classList.add("cdk-visually-hidden");
    liveEl.setAttribute("aria-atomic", "true");
    liveEl.setAttribute("aria-live", "polite");
    liveEl.id = `cdk-live-announcer-${uniqueIds++}`;
    this._document.body.appendChild(liveEl);
    return liveEl;
  }
  _exposeAnnouncerToModals(id) {
    const modals = this._document.querySelectorAll('body > .cdk-overlay-container [aria-modal="true"]');
    for (let i = 0; i < modals.length; i++) {
      const modal = modals[i];
      const ariaOwns = modal.getAttribute("aria-owns");
      if (!ariaOwns) {
        modal.setAttribute("aria-owns", id);
      } else if (ariaOwns.indexOf(id) === -1) {
        modal.setAttribute("aria-owns", ariaOwns + " " + id);
      }
    }
  }
  static ɵfac = function LiveAnnouncer_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _LiveAnnouncer)();
  };
  static ɵprov = ɵɵdefineService({
    token: _LiveAnnouncer,
    factory: _LiveAnnouncer.ɵfac
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(LiveAnnouncer, [{
    type: Service
  }], () => [], null);
})();
var CdkAriaLive = class _CdkAriaLive {
  _elementRef = inject(ElementRef);
  _liveAnnouncer = inject(LiveAnnouncer);
  _contentObserver = inject(ContentObserver);
  _ngZone = inject(NgZone);
  get politeness() {
    return this._politeness;
  }
  set politeness(value) {
    this._politeness = value === "off" || value === "assertive" ? value : "polite";
    if (this._politeness === "off") {
      if (this._subscription) {
        this._subscription.unsubscribe();
        this._subscription = void 0;
      }
    } else if (!this._subscription) {
      this._subscription = this._ngZone.runOutsideAngular(() => {
        return this._contentObserver.observe(this._elementRef).subscribe(() => {
          const elementText = this._elementRef.nativeElement.textContent;
          if (elementText !== this._previousAnnouncedText) {
            this._liveAnnouncer.announce(elementText, this._politeness, this.duration);
            this._previousAnnouncedText = elementText;
          }
        });
      });
    }
  }
  _politeness = "polite";
  duration;
  _previousAnnouncedText;
  _subscription;
  constructor() {
    inject(_CdkPrivateStyleLoader).load(_VisuallyHiddenLoader);
  }
  ngOnDestroy() {
    this._subscription?.unsubscribe();
  }
  static ɵfac = function CdkAriaLive_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _CdkAriaLive)();
  };
  static ɵdir = ɵɵdefineDirective({
    type: _CdkAriaLive,
    selectors: [["", "cdkAriaLive", ""]],
    inputs: {
      politeness: [0, "cdkAriaLive", "politeness"],
      duration: [0, "cdkAriaLiveDuration", "duration"]
    },
    exportAs: ["cdkAriaLive"]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(CdkAriaLive, [{
    type: Directive,
    args: [{
      selector: "[cdkAriaLive]",
      exportAs: "cdkAriaLive"
    }]
  }], () => [], {
    politeness: [{
      type: Input,
      args: ["cdkAriaLive"]
    }],
    duration: [{
      type: Input,
      args: ["cdkAriaLiveDuration"]
    }]
  });
})();
var HighContrastMode;
(function(HighContrastMode2) {
  HighContrastMode2[HighContrastMode2["NONE"] = 0] = "NONE";
  HighContrastMode2[HighContrastMode2["BLACK_ON_WHITE"] = 1] = "BLACK_ON_WHITE";
  HighContrastMode2[HighContrastMode2["WHITE_ON_BLACK"] = 2] = "WHITE_ON_BLACK";
})(HighContrastMode || (HighContrastMode = {}));
var BLACK_ON_WHITE_CSS_CLASS = "cdk-high-contrast-black-on-white";
var WHITE_ON_BLACK_CSS_CLASS = "cdk-high-contrast-white-on-black";
var HIGH_CONTRAST_MODE_ACTIVE_CSS_CLASS = "cdk-high-contrast-active";
var HighContrastModeDetector = class _HighContrastModeDetector {
  _platform = inject(Platform);
  _hasCheckedHighContrastMode = false;
  _document = inject(DOCUMENT);
  _breakpointSubscription;
  constructor() {
    this._breakpointSubscription = inject(BreakpointObserver).observe("(forced-colors: active)").subscribe(() => {
      if (this._hasCheckedHighContrastMode) {
        this._hasCheckedHighContrastMode = false;
        this._applyBodyHighContrastModeCssClasses();
      }
    });
  }
  getHighContrastMode() {
    if (!this._platform.isBrowser) {
      return HighContrastMode.NONE;
    }
    const testElement = this._document.createElement("div");
    testElement.style.backgroundColor = "rgb(1,2,3)";
    testElement.style.position = "absolute";
    this._document.body.appendChild(testElement);
    const documentWindow = this._document.defaultView || window;
    const computedStyle = documentWindow && documentWindow.getComputedStyle ? documentWindow.getComputedStyle(testElement) : null;
    const computedColor = (computedStyle && computedStyle.backgroundColor || "").replace(/ /g, "");
    testElement.remove();
    switch (computedColor) {
      case "rgb(0,0,0)":
      case "rgb(45,50,54)":
      case "rgb(32,32,32)":
        return HighContrastMode.WHITE_ON_BLACK;
      case "rgb(255,255,255)":
      case "rgb(255,250,239)":
        return HighContrastMode.BLACK_ON_WHITE;
    }
    return HighContrastMode.NONE;
  }
  ngOnDestroy() {
    this._breakpointSubscription.unsubscribe();
  }
  _applyBodyHighContrastModeCssClasses() {
    if (!this._hasCheckedHighContrastMode && this._platform.isBrowser && this._document.body) {
      const bodyClasses = this._document.body.classList;
      bodyClasses.remove(HIGH_CONTRAST_MODE_ACTIVE_CSS_CLASS, BLACK_ON_WHITE_CSS_CLASS, WHITE_ON_BLACK_CSS_CLASS);
      this._hasCheckedHighContrastMode = true;
      const mode = this.getHighContrastMode();
      if (mode === HighContrastMode.BLACK_ON_WHITE) {
        bodyClasses.add(HIGH_CONTRAST_MODE_ACTIVE_CSS_CLASS, BLACK_ON_WHITE_CSS_CLASS);
      } else if (mode === HighContrastMode.WHITE_ON_BLACK) {
        bodyClasses.add(HIGH_CONTRAST_MODE_ACTIVE_CSS_CLASS, WHITE_ON_BLACK_CSS_CLASS);
      }
    }
  }
  static ɵfac = function HighContrastModeDetector_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _HighContrastModeDetector)();
  };
  static ɵprov = ɵɵdefineService({
    token: _HighContrastModeDetector,
    factory: _HighContrastModeDetector.ɵfac
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(HighContrastModeDetector, [{
    type: Service
  }], () => [], null);
})();
var A11yModule = class _A11yModule {
  constructor() {
    inject(HighContrastModeDetector)._applyBodyHighContrastModeCssClasses();
  }
  static ɵfac = function A11yModule_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _A11yModule)();
  };
  static ɵmod = ɵɵdefineNgModule({
    type: _A11yModule,
    imports: [ObserversModule, CdkAriaLive, CdkTrapFocus, CdkMonitorFocus],
    exports: [CdkAriaLive, CdkTrapFocus, CdkMonitorFocus]
  });
  static ɵinj = ɵɵdefineInjector({
    imports: [ObserversModule]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(A11yModule, [{
    type: NgModule,
    args: [{
      imports: [ObserversModule, CdkAriaLive, CdkTrapFocus, CdkMonitorFocus],
      exports: [CdkAriaLive, CdkTrapFocus, CdkMonitorFocus]
    }]
  }], () => [], null);
})();

// node_modules/@angular/cdk/fesm2022/dialog.mjs
function CdkDialogContainer_ng_template_0_Template(rf, ctx) {
}
var DialogConfig = class {
  viewContainerRef;
  injector;
  id;
  role = "dialog";
  panelClass = "";
  hasBackdrop = true;
  backdropClass = "";
  disableClose = false;
  closePredicate;
  width = "";
  height = "";
  minWidth;
  minHeight;
  maxWidth;
  maxHeight;
  positionStrategy;
  data = null;
  direction;
  ariaDescribedBy = null;
  ariaLabelledBy = null;
  ariaLabel = null;
  ariaModal = false;
  autoFocus = "first-tabbable";
  restoreFocus = true;
  scrollStrategy;
  closeOnNavigation = true;
  closeOnDestroy = true;
  closeOnOverlayDetachments = true;
  disableAnimations = false;
  providers;
  container;
  templateContext;
  bindings;
};
function throwDialogContentAlreadyAttachedError() {
  throw Error("Attempting to attach dialog content after content is already attached");
}
var CdkDialogContainer = class _CdkDialogContainer extends BasePortalOutlet {
  _elementRef = inject(ElementRef);
  _focusTrapFactory = inject(FocusTrapFactory);
  _config;
  _interactivityChecker = inject(InteractivityChecker);
  _ngZone = inject(NgZone);
  _focusMonitor = inject(FocusMonitor);
  _renderer = inject(Renderer2);
  _changeDetectorRef = inject(ChangeDetectorRef);
  _injector = inject(Injector);
  _platform = inject(Platform);
  _document = inject(DOCUMENT);
  _portalOutlet;
  _focusTrapped = new Subject();
  _focusTrap = null;
  _elementFocusedBeforeDialogWasOpened = null;
  _closeInteractionType = null;
  _ariaLabelledByQueue = [];
  _isDestroyed = false;
  constructor() {
    super();
    this._config = inject(DialogConfig, {
      optional: true
    }) || new DialogConfig();
    if (this._config.ariaLabelledBy) {
      this._ariaLabelledByQueue.push(this._config.ariaLabelledBy);
    }
  }
  _addAriaLabelledBy(id) {
    this._ariaLabelledByQueue.push(id);
    this._changeDetectorRef.markForCheck();
  }
  _removeAriaLabelledBy(id) {
    const index = this._ariaLabelledByQueue.indexOf(id);
    if (index > -1) {
      this._ariaLabelledByQueue.splice(index, 1);
      this._changeDetectorRef.markForCheck();
    }
  }
  _contentAttached() {
    this._initializeFocusTrap();
    this._captureInitialFocus();
  }
  _captureInitialFocus() {
    this._trapFocus();
  }
  ngOnDestroy() {
    this._focusTrapped.complete();
    this._isDestroyed = true;
    this._restoreFocus();
  }
  attachComponentPortal(portal) {
    if (this._portalOutlet.hasAttached() && (typeof ngDevMode === "undefined" || ngDevMode)) {
      throwDialogContentAlreadyAttachedError();
    }
    const result = this._portalOutlet.attachComponentPortal(portal);
    this._contentAttached();
    return result;
  }
  attachTemplatePortal(portal) {
    if (this._portalOutlet.hasAttached() && (typeof ngDevMode === "undefined" || ngDevMode)) {
      throwDialogContentAlreadyAttachedError();
    }
    const result = this._portalOutlet.attachTemplatePortal(portal);
    this._contentAttached();
    return result;
  }
  attachDomPortal = (portal) => {
    if (this._portalOutlet.hasAttached() && (typeof ngDevMode === "undefined" || ngDevMode)) {
      throwDialogContentAlreadyAttachedError();
    }
    const result = this._portalOutlet.attachDomPortal(portal);
    this._contentAttached();
    return result;
  };
  _recaptureFocus() {
    if (!this._containsFocus()) {
      this._trapFocus();
    }
  }
  _forceFocus(element, options) {
    if (!this._interactivityChecker.isFocusable(element)) {
      element.tabIndex = -1;
      this._ngZone.runOutsideAngular(() => {
        const callback = () => {
          deregisterBlur();
          deregisterMousedown();
          element.removeAttribute("tabindex");
        };
        const deregisterBlur = this._renderer.listen(element, "blur", callback);
        const deregisterMousedown = this._renderer.listen(element, "mousedown", callback);
      });
    }
    element.focus(options);
  }
  _focusByCssSelector(selector, options) {
    let elementToFocus = this._elementRef.nativeElement.querySelector(selector);
    if (elementToFocus) {
      this._forceFocus(elementToFocus, options);
    }
  }
  _trapFocus(options) {
    if (this._isDestroyed) {
      return;
    }
    afterNextRender(() => {
      const element = this._elementRef.nativeElement;
      switch (this._config.autoFocus) {
        case false:
        case "dialog":
          if (!this._containsFocus()) {
            element.focus(options);
          }
          break;
        case true:
        case "first-tabbable":
          const focusedSuccessfully = this._focusTrap?.focusInitialElement(options);
          if (!focusedSuccessfully) {
            this._focusDialogContainer(options);
          }
          break;
        case "first-heading":
          this._focusByCssSelector('h1, h2, h3, h4, h5, h6, [role="heading"]', options);
          break;
        default:
          this._focusByCssSelector(this._config.autoFocus, options);
          break;
      }
      this._focusTrapped.next();
    }, {
      injector: this._injector
    });
  }
  _restoreFocus() {
    const focusConfig = this._config.restoreFocus;
    let focusTargetElement = null;
    if (typeof focusConfig === "string") {
      focusTargetElement = this._document.querySelector(focusConfig);
    } else if (typeof focusConfig === "boolean") {
      focusTargetElement = focusConfig ? this._elementFocusedBeforeDialogWasOpened : null;
    } else if (focusConfig) {
      focusTargetElement = focusConfig;
    }
    if (this._config.restoreFocus && focusTargetElement && typeof focusTargetElement.focus === "function") {
      const activeElement = _getFocusedElementPierceShadowDom();
      const element = this._elementRef.nativeElement;
      if (!activeElement || activeElement === this._document.body || activeElement === element || element.contains(activeElement)) {
        if (this._focusMonitor) {
          this._focusMonitor.focusVia(focusTargetElement, this._closeInteractionType);
          this._closeInteractionType = null;
        } else {
          focusTargetElement.focus();
        }
      }
    }
    if (this._focusTrap) {
      this._focusTrap.destroy();
    }
  }
  _focusDialogContainer(options) {
    this._elementRef.nativeElement.focus?.(options);
  }
  _containsFocus() {
    const element = this._elementRef.nativeElement;
    const activeElement = _getFocusedElementPierceShadowDom();
    return element === activeElement || element.contains(activeElement);
  }
  _initializeFocusTrap() {
    if (this._platform.isBrowser) {
      this._focusTrap = this._focusTrapFactory.create(this._elementRef.nativeElement);
      if (this._document) {
        this._elementFocusedBeforeDialogWasOpened = _getFocusedElementPierceShadowDom();
      }
    }
  }
  static ɵfac = function CdkDialogContainer_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _CdkDialogContainer)();
  };
  static ɵcmp = ɵɵdefineComponent({
    type: _CdkDialogContainer,
    selectors: [["cdk-dialog-container"]],
    viewQuery: function CdkDialogContainer_Query(rf, ctx) {
      if (rf & 1) {
        ɵɵviewQuery(CdkPortalOutlet, 7);
      }
      if (rf & 2) {
        let _t;
        ɵɵqueryRefresh(_t = ɵɵloadQuery()) && (ctx._portalOutlet = _t.first);
      }
    },
    hostAttrs: ["tabindex", "-1", 1, "cdk-dialog-container"],
    hostVars: 6,
    hostBindings: function CdkDialogContainer_HostBindings(rf, ctx) {
      if (rf & 2) {
        ɵɵattribute("id", ctx._config.id || null)("role", ctx._config.role)("aria-modal", ctx._config.ariaModal)("aria-labelledby", ctx._config.ariaLabel ? null : ctx._ariaLabelledByQueue[0])("aria-label", ctx._config.ariaLabel)("aria-describedby", ctx._config.ariaDescribedBy || null);
      }
    },
    features: [ɵɵInheritDefinitionFeature],
    decls: 1,
    vars: 0,
    consts: [["cdkPortalOutlet", ""]],
    template: function CdkDialogContainer_Template(rf, ctx) {
      if (rf & 1) {
        ɵɵtemplate(0, CdkDialogContainer_ng_template_0_Template, 0, 0, "ng-template", 0);
      }
    },
    dependencies: [CdkPortalOutlet],
    styles: [".cdk-dialog-container {\n  display: block;\n  width: 100%;\n  height: 100%;\n  min-height: inherit;\n  max-height: inherit;\n}\n"],
    encapsulation: 2,
    changeDetection: 1
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(CdkDialogContainer, [{
    type: Component,
    args: [{
      selector: "cdk-dialog-container",
      encapsulation: ViewEncapsulation.None,
      changeDetection: ChangeDetectionStrategy.Eager,
      imports: [CdkPortalOutlet],
      host: {
        "class": "cdk-dialog-container",
        "tabindex": "-1",
        "[attr.id]": "_config.id || null",
        "[attr.role]": "_config.role",
        "[attr.aria-modal]": "_config.ariaModal",
        "[attr.aria-labelledby]": "_config.ariaLabel ? null : _ariaLabelledByQueue[0]",
        "[attr.aria-label]": "_config.ariaLabel",
        "[attr.aria-describedby]": "_config.ariaDescribedBy || null"
      },
      template: "<ng-template cdkPortalOutlet />\n",
      styles: [".cdk-dialog-container {\n  display: block;\n  width: 100%;\n  height: 100%;\n  min-height: inherit;\n  max-height: inherit;\n}\n"]
    }]
  }], () => [], {
    _portalOutlet: [{
      type: ViewChild,
      args: [CdkPortalOutlet, {
        static: true
      }]
    }]
  });
})();
var DialogRef = class {
  overlayRef;
  config;
  componentInstance = null;
  componentRef = null;
  containerInstance;
  disableClose;
  closed = new Subject();
  backdropClick;
  keydownEvents;
  outsidePointerEvents;
  id;
  _detachSubscription;
  constructor(overlayRef, config) {
    this.overlayRef = overlayRef;
    this.config = config;
    this.disableClose = config.disableClose;
    this.backdropClick = overlayRef.backdropClick();
    this.keydownEvents = overlayRef.keydownEvents();
    this.outsidePointerEvents = overlayRef.outsidePointerEvents();
    this.id = config.id;
    this.keydownEvents.subscribe((event) => {
      if (event.keyCode === ESCAPE && !this.disableClose && !hasModifierKey(event)) {
        event.preventDefault();
        this.close(void 0, {
          focusOrigin: "keyboard"
        });
      }
    });
    this.backdropClick.subscribe(() => {
      if (!this.disableClose && this._canClose()) {
        this.close(void 0, {
          focusOrigin: "mouse"
        });
      } else {
        this.containerInstance._recaptureFocus?.();
      }
    });
    this._detachSubscription = overlayRef.detachments().subscribe(() => {
      if (config.closeOnOverlayDetachments !== false) {
        this.close();
      }
    });
  }
  close(result, options) {
    if (this._canClose(result)) {
      const closedSubject = this.closed;
      this.containerInstance._closeInteractionType = options?.focusOrigin || "program";
      this._detachSubscription.unsubscribe();
      this.overlayRef.dispose();
      closedSubject.next(result);
      closedSubject.complete();
      this.componentInstance = this.containerInstance = null;
    }
  }
  updatePosition() {
    this.overlayRef.updatePosition();
    return this;
  }
  updateSize(width = "", height = "") {
    this.overlayRef.updateSize({
      width,
      height
    });
    return this;
  }
  addPanelClass(classes) {
    this.overlayRef.addPanelClass(classes);
    return this;
  }
  removePanelClass(classes) {
    this.overlayRef.removePanelClass(classes);
    return this;
  }
  _canClose(result) {
    const config = this.config;
    return !!this.containerInstance && (!config.closePredicate || config.closePredicate(result, config, this.componentInstance));
  }
};
var DIALOG_SCROLL_STRATEGY = new InjectionToken("DialogScrollStrategy", {
  providedIn: "root",
  factory: () => {
    const injector = inject(Injector);
    return () => createBlockScrollStrategy(injector);
  }
});
var DIALOG_DATA = new InjectionToken("DialogData");
var DEFAULT_DIALOG_CONFIG = new InjectionToken("DefaultDialogConfig");
function getDirectionality(value) {
  const valueSignal = signal(value, ...ngDevMode ? [{
    debugName: "valueSignal"
  }] : []);
  const change = new EventEmitter();
  return {
    valueSignal,
    get value() {
      return valueSignal();
    },
    change,
    ngOnDestroy() {
      change.complete();
    }
  };
}
var Dialog = class _Dialog {
  _injector = inject(Injector);
  _defaultOptions = inject(DEFAULT_DIALOG_CONFIG, {
    optional: true
  });
  _parentDialog = inject(_Dialog, {
    optional: true,
    skipSelf: true
  });
  _overlayContainer = inject(OverlayContainer);
  _idGenerator = inject(_IdGenerator);
  _openDialogsAtThisLevel = [];
  _afterAllClosedAtThisLevel = new Subject();
  _afterOpenedAtThisLevel = new Subject();
  _ariaHiddenElements = /* @__PURE__ */ new Map();
  _scrollStrategy = inject(DIALOG_SCROLL_STRATEGY);
  get openDialogs() {
    return this._parentDialog ? this._parentDialog.openDialogs : this._openDialogsAtThisLevel;
  }
  get afterOpened() {
    return this._parentDialog ? this._parentDialog.afterOpened : this._afterOpenedAtThisLevel;
  }
  afterAllClosed = defer(() => this.openDialogs.length ? this._getAfterAllClosed() : this._getAfterAllClosed().pipe(startWith(void 0)));
  open(componentOrTemplateRef, config) {
    const defaults = this._defaultOptions || new DialogConfig();
    config = __spreadValues(__spreadValues({}, defaults), config);
    config.id = config.id || this._idGenerator.getId("cdk-dialog-");
    if (config.id && this.getDialogById(config.id) && (typeof ngDevMode === "undefined" || ngDevMode)) {
      throw Error(`Dialog with id "${config.id}" exists already. The dialog id must be unique.`);
    }
    const overlayConfig = this._getOverlayConfig(config);
    const overlayRef = createOverlayRef(this._injector, overlayConfig);
    const dialogRef = new DialogRef(overlayRef, config);
    const dialogContainer = this._attachContainer(overlayRef, dialogRef, config);
    dialogRef.containerInstance = dialogContainer;
    if (!this.openDialogs.length) {
      const overlayContainer = this._overlayContainer.getContainerElement();
      if (dialogContainer._focusTrapped) {
        dialogContainer._focusTrapped.pipe(take(1)).subscribe(() => {
          this._hideNonDialogContentFromAssistiveTechnology(overlayContainer);
        });
      } else {
        this._hideNonDialogContentFromAssistiveTechnology(overlayContainer);
      }
    }
    this._attachDialogContent(componentOrTemplateRef, dialogRef, dialogContainer, config);
    this.openDialogs.push(dialogRef);
    dialogRef.closed.subscribe(() => this._removeOpenDialog(dialogRef, true));
    this.afterOpened.next(dialogRef);
    return dialogRef;
  }
  closeAll() {
    reverseForEach(this.openDialogs, (dialog) => dialog.close());
  }
  getDialogById(id) {
    return this.openDialogs.find((dialog) => dialog.id === id);
  }
  ngOnDestroy() {
    reverseForEach(this._openDialogsAtThisLevel, (dialog) => {
      if (dialog.config.closeOnDestroy === false) {
        this._removeOpenDialog(dialog, false);
      }
    });
    reverseForEach(this._openDialogsAtThisLevel, (dialog) => dialog.close());
    this._afterAllClosedAtThisLevel.complete();
    this._afterOpenedAtThisLevel.complete();
    this._openDialogsAtThisLevel = [];
  }
  _getOverlayConfig(config) {
    const state = new OverlayConfig({
      positionStrategy: config.positionStrategy || createGlobalPositionStrategy().centerHorizontally().centerVertically(),
      scrollStrategy: config.scrollStrategy || this._scrollStrategy(),
      panelClass: config.panelClass,
      hasBackdrop: config.hasBackdrop,
      direction: config.direction,
      minWidth: config.minWidth,
      minHeight: config.minHeight,
      maxWidth: config.maxWidth,
      maxHeight: config.maxHeight,
      width: config.width,
      height: config.height,
      disposeOnNavigation: config.closeOnNavigation,
      disableAnimations: config.disableAnimations
    });
    if (config.backdropClass) {
      state.backdropClass = config.backdropClass;
    }
    return state;
  }
  _attachContainer(overlay, dialogRef, config) {
    const userInjector = config.injector || config.viewContainerRef?.injector;
    const providers = [{
      provide: DialogConfig,
      useValue: config
    }, {
      provide: DialogRef,
      useValue: dialogRef
    }, {
      provide: OverlayRef,
      useValue: overlay
    }];
    let containerType;
    if (config.container) {
      if (typeof config.container === "function") {
        containerType = config.container;
      } else {
        containerType = config.container.type;
        providers.push(...config.container.providers(config));
      }
    } else {
      containerType = CdkDialogContainer;
    }
    const containerPortal = new ComponentPortal(containerType, config.viewContainerRef, Injector.create({
      parent: userInjector || this._injector,
      providers
    }));
    const containerRef = overlay.attach(containerPortal);
    return containerRef.instance;
  }
  _attachDialogContent(componentOrTemplateRef, dialogRef, dialogContainer, config) {
    if (componentOrTemplateRef instanceof TemplateRef) {
      const injector = this._createInjector(config, dialogRef, dialogContainer, void 0);
      let context = {
        $implicit: config.data,
        dialogRef
      };
      if (config.templateContext) {
        context = __spreadValues(__spreadValues({}, context), typeof config.templateContext === "function" ? config.templateContext() : config.templateContext);
      }
      dialogContainer.attachTemplatePortal(new TemplatePortal(componentOrTemplateRef, null, context, injector));
    } else {
      const injector = this._createInjector(config, dialogRef, dialogContainer, this._injector);
      const contentRef = dialogContainer.attachComponentPortal(new ComponentPortal(componentOrTemplateRef, config.viewContainerRef, injector, null, config.bindings));
      dialogRef.componentRef = contentRef;
      dialogRef.componentInstance = contentRef.instance;
    }
  }
  _createInjector(config, dialogRef, dialogContainer, fallbackInjector) {
    const userInjector = config.injector || config.viewContainerRef?.injector;
    const providers = [{
      provide: DIALOG_DATA,
      useValue: config.data
    }, {
      provide: DialogRef,
      useValue: dialogRef
    }];
    if (config.providers) {
      if (typeof config.providers === "function") {
        providers.push(...config.providers(dialogRef, config, dialogContainer));
      } else {
        providers.push(...config.providers);
      }
    }
    if (config.direction && (!userInjector || !userInjector.get(Directionality, null, {
      optional: true
    }))) {
      providers.push({
        provide: Directionality,
        useValue: getDirectionality(config.direction)
      });
    }
    return Injector.create({
      parent: userInjector || fallbackInjector,
      providers
    });
  }
  _removeOpenDialog(dialogRef, emitEvent) {
    const index = this.openDialogs.indexOf(dialogRef);
    if (index > -1) {
      this.openDialogs.splice(index, 1);
      if (!this.openDialogs.length) {
        this._ariaHiddenElements.forEach((previousValue, element) => {
          if (previousValue) {
            element.setAttribute("aria-hidden", previousValue);
          } else {
            element.removeAttribute("aria-hidden");
          }
        });
        this._ariaHiddenElements.clear();
        if (emitEvent) {
          this._getAfterAllClosed().next();
        }
      }
    }
  }
  _hideNonDialogContentFromAssistiveTechnology(overlayContainer) {
    if (overlayContainer.parentElement) {
      const siblings = overlayContainer.parentElement.children;
      for (let i = siblings.length - 1; i > -1; i--) {
        const sibling = siblings[i];
        if (sibling !== overlayContainer && sibling.nodeName !== "SCRIPT" && sibling.nodeName !== "STYLE" && !sibling.hasAttribute("aria-live") && !sibling.hasAttribute("popover")) {
          this._ariaHiddenElements.set(sibling, sibling.getAttribute("aria-hidden"));
          sibling.setAttribute("aria-hidden", "true");
        }
      }
    }
  }
  _getAfterAllClosed() {
    const parent = this._parentDialog;
    return parent ? parent._getAfterAllClosed() : this._afterAllClosedAtThisLevel;
  }
  static ɵfac = function Dialog_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _Dialog)();
  };
  static ɵprov = ɵɵdefineService({
    token: _Dialog,
    factory: _Dialog.ɵfac
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(Dialog, [{
    type: Service
  }], null, null);
})();
function reverseForEach(items, callback) {
  let i = items.length;
  while (i--) {
    callback(items[i]);
  }
}
var DialogModule = class _DialogModule {
  static ɵfac = function DialogModule_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _DialogModule)();
  };
  static ɵmod = ɵɵdefineNgModule({
    type: _DialogModule,
    imports: [OverlayModule, PortalModule, A11yModule, CdkDialogContainer],
    exports: [PortalModule, CdkDialogContainer]
  });
  static ɵinj = ɵɵdefineInjector({
    providers: [Dialog],
    imports: [OverlayModule, PortalModule, A11yModule, PortalModule]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(DialogModule, [{
    type: NgModule,
    args: [{
      imports: [OverlayModule, PortalModule, A11yModule, CdkDialogContainer],
      exports: [PortalModule, CdkDialogContainer],
      providers: [Dialog]
    }]
  }], null, null);
})();

// node_modules/@spartan-ng/brain/fesm2022/spartan-ng-brain-dialog.mjs
var defaultOptions = {
  ariaDescribedBy: void 0,
  ariaLabel: void 0,
  ariaLabelledBy: void 0,
  ariaModal: true,
  attachPositions: [],
  attachTo: null,
  autoFocus: "first-tabbable",
  backdropClass: "",
  closeOnOutsidePointerEvents: false,
  disableClose: false,
  hasBackdrop: true,
  panelClass: "",
  positionStrategy: null,
  restoreFocus: true,
  role: "dialog",
  scrollStrategy: null
};
var BRN_DIALOG_DEFAULT_OPTIONS = new InjectionToken("brn-dialog-default-options", {
  providedIn: "root",
  factory: () => defaultOptions
});
function provideBrnDialogDefaultOptions(options) {
  return {
    provide: BRN_DIALOG_DEFAULT_OPTIONS,
    useValue: __spreadValues(__spreadValues({}, defaultOptions), options)
  };
}
function injectBrnDialogDefaultOptions() {
  return inject(BRN_DIALOG_DEFAULT_OPTIONS, {
    optional: true
  }) ?? defaultOptions;
}
var BrnDialogRef = class {
  _cdkDialogRef;
  _injector;
  dialogId;
  initialOptions;
  _closing = new Subject();
  closing$ = this._closing.asObservable();
  _closed = new ReplaySubject(1);
  closed$ = this._closed.asObservable();
  _stateChanged = new ReplaySubject(1);
  stateChanged$ = this._stateChanged.asObservable();
  _phase = signal("open", ...ngDevMode ? [{
    debugName: "_phase"
  }] : (
    /* istanbul ignore next */
    []
  ));
  phase = this._phase.asReadonly();
  state = computed(() => this._phase() === "open" ? "open" : "closed", ...ngDevMode ? [{
    debugName: "state"
  }] : (
    /* istanbul ignore next */
    []
  ));
  _closeGeneration = 0;
  _panelClasses;
  _backdropClasses;
  get open() {
    return this._phase() === "open";
  }
  get id() {
    return this.initialOptions.id;
  }
  constructor(_cdkDialogRef, _injector, dialogId, initialOptions) {
    this._cdkDialogRef = _cdkDialogRef;
    this._injector = _injector;
    this.dialogId = dialogId;
    this.initialOptions = initialOptions;
    this._panelClasses = cssClassesToArray(initialOptions.panelClass);
    this._backdropClasses = cssClassesToArray(initialOptions.backdropClass);
    this._setDataState("open");
    this._stateChanged.next("open");
    this._cdkDialogRef.closed.subscribe((result) => {
      this._phase.set("closed");
      this._closed.next(result);
      this._closed.complete();
      this._closing.complete();
      this._stateChanged.complete();
    });
  }
  close(result) {
    if (!this.open) return;
    const generation = ++this._closeGeneration;
    const animationsBeforeClose = new Set(this._getActiveAnimations());
    this._phase.set("closing");
    this._setDataState("closed");
    this._closing.next();
    this._stateChanged.next("closed");
    afterNextRender(() => {
      void this._finishClose(generation, animationsBeforeClose, result);
    }, {
      injector: this._injector
    });
  }
  dismiss(reason) {
    const options = this.initialOptions;
    if (!this.open || options.disableClose) return false;
    if (reason === "outside" && !options.closeOnOutsidePointerEvents) return false;
    this.close();
    return true;
  }
  reopen() {
    if (this._phase() !== "closing") return;
    this._closeGeneration++;
    this._phase.set("open");
    this._setDataState("open");
    this._stateChanged.next("open");
  }
  forceClose(result) {
    if (this._phase() === "closed") return;
    this._closeGeneration++;
    this._phase.set("closed");
    this._cdkDialogRef.close(result);
  }
  setPanelClass(panelClass) {
    if (this._panelClasses.length) this._cdkDialogRef.removePanelClass(this._panelClasses);
    this._panelClasses = cssClassesToArray(panelClass);
    if (this._panelClasses.length) this._cdkDialogRef.addPanelClass(this._panelClasses);
  }
  setOverlayClass(overlayClass) {
    const backdrop = this._cdkDialogRef.overlayRef.backdropElement;
    if (!backdrop) return;
    backdrop.classList.remove(...this._backdropClasses);
    this._backdropClasses = cssClassesToArray(overlayClass);
    backdrop.classList.add(...this._backdropClasses);
  }
  updatePosition() {
    this._cdkDialogRef.updatePosition();
  }
  async _finishClose(generation, animationsBeforeClose, result) {
    if (generation !== this._closeGeneration || this._phase() !== "closing") return;
    const exitAnimations = this._getActiveAnimations().filter((animation) => !animationsBeforeClose.has(animation));
    for (const animation of exitAnimations) {
      animation.effect?.updateTiming({
        fill: "forwards"
      });
    }
    await waitForAnimations(exitAnimations);
    if (generation === this._closeGeneration && this._phase() === "closing") {
      this._phase.set("closed");
      this._cdkDialogRef.close(result);
    }
  }
  _getActiveAnimations() {
    return getActiveElementAnimations([this._cdkDialogRef.overlayRef.overlayElement, this._cdkDialogRef.overlayRef.backdropElement]);
  }
  _setDataState(state) {
    this._cdkDialogRef.overlayRef.overlayElement.setAttribute("data-state", state);
    this._cdkDialogRef.overlayRef.backdropElement?.setAttribute("data-state", state);
  }
};
var dialogSequence = 0;
var injectBrnDialogContext = (options = {}) => inject(DIALOG_DATA, options);
var BrnDialogService = class _BrnDialogService {
  _overlayCloseDispatcher = inject(OverlayOutsideClickDispatcher);
  _cdkDialog = inject(Dialog);
  _positionBuilder = inject(OverlayPositionBuilder);
  _scrollStrategies = inject(ScrollStrategyOptions);
  _injector = inject(Injector);
  _defaultOptions = injectBrnDialogDefaultOptions();
  open(content, vcr, context, options) {
    const dialogId = ++dialogSequence;
    const mergedOptions = __spreadProps(__spreadValues(__spreadValues({}, this._defaultOptions), options), {
      id: options?.id ?? `brn-dialog-${dialogId}`
    });
    if (this._cdkDialog.getDialogById(mergedOptions.id)) {
      throw new Error(`Dialog with ID: ${mergedOptions.id} already exists`);
    }
    const positionStrategy = mergedOptions.positionStrategy ?? (mergedOptions.attachTo && mergedOptions.attachPositions.length ? this._positionBuilder.flexibleConnectedTo(mergedOptions.attachTo).withPositions(mergedOptions.attachPositions) : this._positionBuilder.global().centerHorizontally().centerVertically());
    const scrollStrategy = mergedOptions.scrollStrategy === "close" ? this._scrollStrategies.close() : mergedOptions.scrollStrategy === "reposition" ? this._scrollStrategies.reposition() : mergedOptions.scrollStrategy ?? this._scrollStrategies.block();
    let brnDialogRef;
    const contextOrData = __spreadProps(__spreadValues({}, context), {
      close: (result = void 0) => brnDialogRef.close(result)
    });
    const cdkDialogRef = this._cdkDialog.open(content, {
      id: mergedOptions.id,
      role: mergedOptions.role,
      viewContainerRef: vcr,
      templateContext: () => ({
        $implicit: contextOrData
      }),
      data: contextOrData,
      direction: mergedOptions.direction,
      hasBackdrop: mergedOptions.hasBackdrop,
      panelClass: mergedOptions.panelClass,
      backdropClass: mergedOptions.backdropClass,
      positionStrategy,
      scrollStrategy,
      restoreFocus: mergedOptions.restoreFocus,
      disableClose: true,
      autoFocus: mergedOptions.autoFocus,
      ariaDescribedBy: mergedOptions.ariaDescribedBy === void 0 ? `brn-dialog-description-${dialogId}` : mergedOptions.ariaDescribedBy,
      ariaLabelledBy: mergedOptions.ariaLabelledBy === void 0 ? `brn-dialog-title-${dialogId}` : mergedOptions.ariaLabelledBy,
      ariaLabel: mergedOptions.ariaLabel,
      ariaModal: mergedOptions.ariaModal,
      providers: (dialogRef) => {
        brnDialogRef = new BrnDialogRef(dialogRef, this._injector, dialogId, mergedOptions);
        return this._createProviders(brnDialogRef, mergedOptions);
      }
    });
    this._connectDismissalEvents(brnDialogRef, cdkDialogRef.overlayRef);
    return brnDialogRef;
  }
  _createProviders(dialogRef, options) {
    const providers = [{
      provide: BrnDialogRef,
      useValue: dialogRef
    }];
    if (options.providers) {
      providers.push(...typeof options.providers === "function" ? options.providers() : options.providers);
    }
    return providers;
  }
  _connectDismissalEvents(dialogRef, overlayRef) {
    const closed$ = dialogRef.closed$;
    overlayRef.outsidePointerEvents().pipe(takeUntil(closed$)).subscribe(() => {
      if (this._isTopmostOutsideTarget(overlayRef)) dialogRef.dismiss("outside");
    });
    overlayRef.backdropClick().pipe(takeUntil(closed$)).subscribe(() => dialogRef.dismiss("backdrop"));
    overlayRef.keydownEvents().pipe(filter((event) => event.key === "Escape"), takeUntil(closed$)).subscribe((event) => {
      if (this._overlayCloseDispatcher._attachedOverlays.at(-1) !== overlayRef) return;
      if (dialogRef.dismiss("escape")) event.preventDefault();
    });
  }
  _isTopmostOutsideTarget(overlayRef) {
    const overlays = this._overlayCloseDispatcher._attachedOverlays;
    const index = overlays.indexOf(overlayRef);
    return index === overlays.length - 1 || overlays.length > 1 && !this._isNested(overlayRef, overlays.at(-1));
  }
  _isNested(parent, child) {
    const childOrigin = child.getConfig().positionStrategy._origin;
    if (!childOrigin) return false;
    if ("x" in childOrigin && "y" in childOrigin) {
      const rect = parent.hostElement.getBoundingClientRect();
      return childOrigin.x >= rect.left && childOrigin.x <= rect.right && childOrigin.y >= rect.top && childOrigin.y <= rect.bottom;
    }
    const element = childOrigin instanceof ElementRef ? childOrigin.nativeElement : childOrigin;
    return typeof Node !== "undefined" && element instanceof Node ? parent.hostElement.contains(element) : false;
  }
  /** @nocollapse */
  static ɵfac = function BrnDialogService_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _BrnDialogService)();
  };
  /** @nocollapse */
  static ɵprov = ɵɵdefineInjectable({
    token: _BrnDialogService,
    factory: _BrnDialogService.ɵfac,
    providedIn: "root"
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnDialogService, [{
    type: Injectable,
    args: [{
      providedIn: "root"
    }]
  }], null, null);
})();
var dialogIdSequence = 0;
var BrnDialog = class _BrnDialog {
  _dialogService = inject(BrnDialogService);
  _destroyRef = inject(DestroyRef);
  _vcr = inject(ViewContainerRef);
  _positionBuilder = inject(OverlayPositionBuilder);
  _scrollStrategies = inject(ScrollStrategyOptions);
  _injector = inject(Injector);
  _directionality = inject(Directionality);
  _defaultOptions = injectBrnDialogDefaultOptions();
  _dialogRef = signal(void 0, ...ngDevMode ? [{
    debugName: "_dialogRef"
  }] : (
    /* istanbul ignore next */
    []
  ));
  _origin = signal(void 0, ...ngDevMode ? [{
    debugName: "_origin"
  }] : (
    /* istanbul ignore next */
    []
  ));
  _panelClass = signal(void 0, ...ngDevMode ? [{
    debugName: "_panelClass"
  }] : (
    /* istanbul ignore next */
    []
  ));
  _backdropClass = signal(void 0, ...ngDevMode ? [{
    debugName: "_backdropClass"
  }] : (
    /* istanbul ignore next */
    []
  ));
  _content;
  _destroyed = false;
  _overlayClass;
  _resolvedBackdropClass = computed(() => this._backdropClass() ?? this._overlayClass?.() ?? this._defaultOptions.backdropClass, ...ngDevMode ? [{
    debugName: "_resolvedBackdropClass"
  }] : (
    /* istanbul ignore next */
    []
  ));
  _resolvedPanelClass = computed(() => this._panelClass() ?? this._content?.panelClass() ?? this._defaultOptions.panelClass, ...ngDevMode ? [{
    debugName: "_resolvedPanelClass"
  }] : (
    /* istanbul ignore next */
    []
  ));
  closed = output();
  stateChanged = output();
  stateComputed = computed(() => this._dialogRef()?.state() ?? "closed", ...ngDevMode ? [{
    debugName: "stateComputed"
  }] : (
    /* istanbul ignore next */
    []
  ));
  id = input(`brn-dialog-${++dialogIdSequence}`, ...ngDevMode ? [{
    debugName: "id"
  }] : (
    /* istanbul ignore next */
    []
  ));
  state = input(null, ...ngDevMode ? [{
    debugName: "state"
  }] : (
    /* istanbul ignore next */
    []
  ));
  role = input(this._defaultOptions.role, ...ngDevMode ? [{
    debugName: "role"
  }] : (
    /* istanbul ignore next */
    []
  ));
  hasBackdrop = input(this._defaultOptions.hasBackdrop, __spreadProps(__spreadValues({}, ngDevMode ? {
    debugName: "hasBackdrop"
  } : (
    /* istanbul ignore next */
    {}
  )), {
    transform: booleanAttribute
  }));
  positionStrategy = input(this._defaultOptions.positionStrategy, ...ngDevMode ? [{
    debugName: "positionStrategy"
  }] : (
    /* istanbul ignore next */
    []
  ));
  scrollStrategy = input(this._defaultOptions.scrollStrategy, ...ngDevMode ? [{
    debugName: "scrollStrategy"
  }] : (
    /* istanbul ignore next */
    []
  ));
  restoreFocus = input(this._defaultOptions.restoreFocus, ...ngDevMode ? [{
    debugName: "restoreFocus"
  }] : (
    /* istanbul ignore next */
    []
  ));
  closeOnOutsidePointerEvents = input(this._defaultOptions.closeOnOutsidePointerEvents, __spreadProps(__spreadValues({}, ngDevMode ? {
    debugName: "closeOnOutsidePointerEvents"
  } : (
    /* istanbul ignore next */
    {}
  )), {
    transform: booleanAttribute
  }));
  attachTo = input(this._defaultOptions.attachTo, ...ngDevMode ? [{
    debugName: "attachTo"
  }] : (
    /* istanbul ignore next */
    []
  ));
  attachPositions = input(this._defaultOptions.attachPositions, ...ngDevMode ? [{
    debugName: "attachPositions"
  }] : (
    /* istanbul ignore next */
    []
  ));
  autoFocus = input(this._defaultOptions.autoFocus, ...ngDevMode ? [{
    debugName: "autoFocus"
  }] : (
    /* istanbul ignore next */
    []
  ));
  disableClose = input(this._defaultOptions.disableClose, __spreadProps(__spreadValues({}, ngDevMode ? {
    debugName: "disableClose"
  } : (
    /* istanbul ignore next */
    {}
  )), {
    transform: booleanAttribute
  }));
  ariaDescribedBy = input(this._defaultOptions.ariaDescribedBy, __spreadProps(__spreadValues({}, ngDevMode ? {
    debugName: "ariaDescribedBy"
  } : (
    /* istanbul ignore next */
    {}
  )), {
    alias: "aria-describedby"
  }));
  ariaLabelledBy = input(this._defaultOptions.ariaLabelledBy, __spreadProps(__spreadValues({}, ngDevMode ? {
    debugName: "ariaLabelledBy"
  } : (
    /* istanbul ignore next */
    {}
  )), {
    alias: "aria-labelledby"
  }));
  ariaLabel = input(this._defaultOptions.ariaLabel, __spreadProps(__spreadValues({}, ngDevMode ? {
    debugName: "ariaLabel"
  } : (
    /* istanbul ignore next */
    {}
  )), {
    alias: "aria-label"
  }));
  ariaModal = input(this._defaultOptions.ariaModal, __spreadProps(__spreadValues({}, ngDevMode ? {
    debugName: "ariaModal"
  } : (
    /* istanbul ignore next */
    {}
  )), {
    alias: "aria-modal",
    transform: booleanAttribute
  }));
  _options = computed(() => ({
    id: this.id(),
    role: this.role(),
    direction: this._directionality.valueSignal(),
    hasBackdrop: this.hasBackdrop(),
    positionStrategy: this.getPositionStrategy(),
    scrollStrategy: this.getScrollStrategy(),
    restoreFocus: this.restoreFocus(),
    closeOnOutsidePointerEvents: this.closeOnOutsidePointerEvents(),
    attachTo: this.getAttachTo(),
    attachPositions: this.attachPositions(),
    autoFocus: this.autoFocus(),
    disableClose: this.disableClose(),
    backdropClass: cssClassesToArray(this._resolvedBackdropClass()),
    panelClass: cssClassesToArray(this._resolvedPanelClass()),
    ariaDescribedBy: this.ariaDescribedBy(),
    ariaLabelledBy: this.ariaLabelledBy(),
    ariaLabel: this.ariaLabel(),
    ariaModal: this.ariaModal()
  }), ...ngDevMode ? [{
    debugName: "_options"
  }] : (
    /* istanbul ignore next */
    []
  ));
  constructor() {
    this._destroyRef.onDestroy(() => this._destroyed = true);
    this._destroyRef.onDestroy(() => this._dialogRef()?.forceClose());
    this._syncPanelClass();
    this._syncOverlayClass();
    afterNextRender(() => {
      effect(() => {
        const state = this.state();
        if (state === "open") untracked(() => this.open());
        if (state === "closed") untracked(() => this.close());
      }, {
        injector: this._injector
      });
    });
  }
  open() {
    if (!this._content) return;
    const currentRef = this._dialogRef();
    if (currentRef) {
      currentRef.reopen();
      return;
    }
    const dialogRef = this._dialogService.open(this._content.template, this._vcr, this._content.context() ?? {}, this._options());
    this._dialogRef.set(dialogRef);
    dialogRef.stateChanged$.pipe(takeUntilDestroyed(this._destroyRef)).subscribe((state) => {
      if (!this._destroyed) this.stateChanged.emit(state);
    });
    dialogRef.closed$.pipe(takeUntilDestroyed(this._destroyRef)).subscribe((result) => {
      if (this._dialogRef() === dialogRef) this._dialogRef.set(void 0);
      if (!this._destroyed) this.closed.emit(result);
    });
  }
  close(result) {
    this._dialogRef()?.close(result);
  }
  registerContent(template, context, panelClass) {
    this._content = {
      template,
      context,
      panelClass
    };
  }
  registerOverlayClass(overlayClass) {
    this._overlayClass = overlayClass;
  }
  setOrigin(origin) {
    this._origin.set(origin);
  }
  setOverlayClass(overlayClass) {
    this._backdropClass.set(overlayClass);
    this._dialogRef()?.setOverlayClass(overlayClass);
  }
  setPanelClass(panelClass) {
    this._panelClass.set(panelClass);
    this._dialogRef()?.setPanelClass(panelClass);
  }
  updatePosition() {
    this._dialogRef()?.updatePosition();
  }
  getAttachTo() {
    return this._origin() ?? this.attachTo();
  }
  getPositionStrategy() {
    return this.positionStrategy();
  }
  getScrollStrategy() {
    const strategy = this.scrollStrategy();
    if (strategy === "close") return this._scrollStrategies.close();
    if (strategy === "reposition") return this._scrollStrategies.reposition();
    return strategy;
  }
  _syncPanelClass() {
    effect(() => {
      const dialogRef = this._dialogRef();
      if (!dialogRef) return;
      const panelClass = this._resolvedPanelClass();
      untracked(() => dialogRef.setPanelClass(panelClass));
    }, {
      injector: this._injector
    });
  }
  _syncOverlayClass() {
    effect(() => {
      const dialogRef = this._dialogRef();
      if (!dialogRef) return;
      const overlayClass = this._resolvedBackdropClass();
      untracked(() => dialogRef.setOverlayClass(overlayClass));
    }, {
      injector: this._injector
    });
  }
  /** @nocollapse */
  static ɵfac = function BrnDialog_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _BrnDialog)();
  };
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnDialog,
    selectors: [["", "brnDialog", ""], ["brn-dialog"]],
    inputs: {
      id: [1, "id"],
      state: [1, "state"],
      role: [1, "role"],
      hasBackdrop: [1, "hasBackdrop"],
      positionStrategy: [1, "positionStrategy"],
      scrollStrategy: [1, "scrollStrategy"],
      restoreFocus: [1, "restoreFocus"],
      closeOnOutsidePointerEvents: [1, "closeOnOutsidePointerEvents"],
      attachTo: [1, "attachTo"],
      attachPositions: [1, "attachPositions"],
      autoFocus: [1, "autoFocus"],
      disableClose: [1, "disableClose"],
      ariaDescribedBy: [1, "aria-describedby", "ariaDescribedBy"],
      ariaLabelledBy: [1, "aria-labelledby", "ariaLabelledBy"],
      ariaLabel: [1, "aria-label", "ariaLabel"],
      ariaModal: [1, "aria-modal", "ariaModal"]
    },
    outputs: {
      closed: "closed",
      stateChanged: "stateChanged"
    },
    exportAs: ["brnDialog"]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnDialog, [{
    type: Directive,
    args: [{
      selector: "[brnDialog],brn-dialog",
      exportAs: "brnDialog"
    }]
  }], () => [], {
    closed: [{
      type: Output,
      args: ["closed"]
    }],
    stateChanged: [{
      type: Output,
      args: ["stateChanged"]
    }],
    id: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "id",
        required: false
      }]
    }],
    state: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "state",
        required: false
      }]
    }],
    role: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "role",
        required: false
      }]
    }],
    hasBackdrop: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "hasBackdrop",
        required: false
      }]
    }],
    positionStrategy: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "positionStrategy",
        required: false
      }]
    }],
    scrollStrategy: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "scrollStrategy",
        required: false
      }]
    }],
    restoreFocus: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "restoreFocus",
        required: false
      }]
    }],
    closeOnOutsidePointerEvents: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "closeOnOutsidePointerEvents",
        required: false
      }]
    }],
    attachTo: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "attachTo",
        required: false
      }]
    }],
    attachPositions: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "attachPositions",
        required: false
      }]
    }],
    autoFocus: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "autoFocus",
        required: false
      }]
    }],
    disableClose: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "disableClose",
        required: false
      }]
    }],
    ariaDescribedBy: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "aria-describedby",
        required: false
      }]
    }],
    ariaLabelledBy: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "aria-labelledby",
        required: false
      }]
    }],
    ariaLabel: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "aria-label",
        required: false
      }]
    }],
    ariaModal: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "aria-modal",
        required: false
      }]
    }]
  });
})();
var BrnDialogClose = class _BrnDialogClose {
  _brnDialogRef = inject(BrnDialogRef);
  close() {
    this._brnDialogRef.close();
  }
  /** @nocollapse */
  static ɵfac = function BrnDialogClose_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _BrnDialogClose)();
  };
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnDialogClose,
    selectors: [["button", "brnDialogClose", ""]],
    hostBindings: function BrnDialogClose_HostBindings(rf, ctx) {
      if (rf & 1) {
        ɵɵlistener("click", function BrnDialogClose_click_HostBindingHandler() {
          return ctx.close();
        });
      }
    }
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnDialogClose, [{
    type: Directive,
    args: [{
      selector: "button[brnDialogClose]",
      host: {
        "(click)": "close()"
      }
    }]
  }], null, null);
})();
var BrnDialogContent = class _BrnDialogContent {
  _brnDialog = inject(BrnDialog, {
    optional: true
  });
  _brnDialogRef = inject(BrnDialogRef, {
    optional: true
  });
  _template = inject(TemplateRef);
  state = computed(() => this._brnDialog?.stateComputed() ?? this._brnDialogRef?.state() ?? "closed", ...ngDevMode ? [{
    debugName: "state"
  }] : (
    /* istanbul ignore next */
    []
  ));
  className = input(void 0, __spreadProps(__spreadValues({}, ngDevMode ? {
    debugName: "className"
  } : (
    /* istanbul ignore next */
    {}
  )), {
    alias: "class"
  }));
  context = input(void 0, ...ngDevMode ? [{
    debugName: "context"
  }] : (
    /* istanbul ignore next */
    []
  ));
  constructor() {
    this._brnDialog?.registerContent(this._template, this.context, this.className);
  }
  /** @nocollapse */
  static ɵfac = function BrnDialogContent_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _BrnDialogContent)();
  };
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnDialogContent,
    selectors: [["", "brnDialogContent", ""]],
    inputs: {
      className: [1, "class", "className"],
      context: [1, "context"]
    },
    features: [ɵɵProvidersFeature([provideExposesStateProviderExisting(() => _BrnDialogContent)])]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnDialogContent, [{
    type: Directive,
    args: [{
      selector: "[brnDialogContent]",
      providers: [provideExposesStateProviderExisting(() => BrnDialogContent)]
    }]
  }], () => [], {
    className: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "class",
        required: false
      }]
    }],
    context: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "context",
        required: false
      }]
    }]
  });
})();
var BrnDialogDescription = class _BrnDialogDescription {
  _brnDialogRef = inject(BrnDialogRef);
  _id = `brn-dialog-description-${this._brnDialogRef.dialogId}`;
  /** @nocollapse */
  static ɵfac = function BrnDialogDescription_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _BrnDialogDescription)();
  };
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnDialogDescription,
    selectors: [["", "brnDialogDescription", ""]],
    hostVars: 1,
    hostBindings: function BrnDialogDescription_HostBindings(rf, ctx) {
      if (rf & 2) {
        ɵɵdomProperty("id", ctx._id);
      }
    }
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnDialogDescription, [{
    type: Directive,
    args: [{
      selector: "[brnDialogDescription]",
      host: {
        "[id]": "_id"
      }
    }]
  }], null, null);
})();
var BrnDialogOverlay = class _BrnDialogOverlay {
  _brnDialog = inject(BrnDialog);
  _customClass = signal(void 0, ...ngDevMode ? [{
    debugName: "_customClass"
  }] : (
    /* istanbul ignore next */
    []
  ));
  className = input(void 0, __spreadProps(__spreadValues({}, ngDevMode ? {
    debugName: "className"
  } : (
    /* istanbul ignore next */
    {}
  )), {
    alias: "class"
  }));
  _resolvedClass = computed(() => this._customClass() ?? this.className(), ...ngDevMode ? [{
    debugName: "_resolvedClass"
  }] : (
    /* istanbul ignore next */
    []
  ));
  constructor() {
    this._brnDialog.registerOverlayClass(this._resolvedClass);
  }
  setClassToCustomElement(newClass) {
    this._customClass.set(newClass);
  }
  /** @nocollapse */
  static ɵfac = function BrnDialogOverlay_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _BrnDialogOverlay)();
  };
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnDialogOverlay,
    selectors: [["", "brnDialogOverlay", ""], ["brn-dialog-overlay"]],
    inputs: {
      className: [1, "class", "className"]
    },
    features: [ɵɵProvidersFeature([provideCustomClassSettableExisting(() => _BrnDialogOverlay)])]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnDialogOverlay, [{
    type: Directive,
    args: [{
      selector: "[brnDialogOverlay],brn-dialog-overlay",
      providers: [provideCustomClassSettableExisting(() => BrnDialogOverlay)]
    }]
  }], () => [], {
    className: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "class",
        required: false
      }]
    }]
  });
})();
var BrnDialogTitle = class _BrnDialogTitle {
  _brnDialogRef = inject(BrnDialogRef);
  _id = `brn-dialog-title-${this._brnDialogRef.dialogId}`;
  /** @nocollapse */
  static ɵfac = function BrnDialogTitle_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _BrnDialogTitle)();
  };
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnDialogTitle,
    selectors: [["", "brnDialogTitle", ""]],
    hostVars: 1,
    hostBindings: function BrnDialogTitle_HostBindings(rf, ctx) {
      if (rf & 2) {
        ɵɵdomProperty("id", ctx._id);
      }
    }
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnDialogTitle, [{
    type: Directive,
    args: [{
      selector: "[brnDialogTitle]",
      host: {
        "[id]": "_id"
      }
    }]
  }], null, null);
})();
var triggerIdSequence = 0;
var BrnDialogTrigger = class _BrnDialogTrigger {
  _injectedDialog = inject(BrnDialog, {
    optional: true
  });
  _dialogRef = inject(BrnDialogRef, {
    optional: true
  });
  id = input(`brn-dialog-trigger-${++triggerIdSequence}`, ...ngDevMode ? [{
    debugName: "id"
  }] : (
    /* istanbul ignore next */
    []
  ));
  type = input("button", ...ngDevMode ? [{
    debugName: "type"
  }] : (
    /* istanbul ignore next */
    []
  ));
  brnDialogTriggerFor = input(void 0, __spreadProps(__spreadValues({}, ngDevMode ? {
    debugName: "brnDialogTriggerFor"
  } : (
    /* istanbul ignore next */
    {}
  )), {
    alias: "brnDialogTriggerFor"
  }));
  state = computed(() => this.getDialog()?.stateComputed() ?? this._dialogRef?.state() ?? "closed", ...ngDevMode ? [{
    debugName: "state"
  }] : (
    /* istanbul ignore next */
    []
  ));
  dialogId = computed(() => this.getDialog()?.id() ?? this._dialogRef?.id ?? null, ...ngDevMode ? [{
    debugName: "dialogId"
  }] : (
    /* istanbul ignore next */
    []
  ));
  getDialog() {
    return this.brnDialogTriggerFor() ?? this._injectedDialog ?? void 0;
  }
  open() {
    this.getDialog()?.open();
  }
  /** @nocollapse */
  static ɵfac = function BrnDialogTrigger_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _BrnDialogTrigger)();
  };
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnDialogTrigger,
    selectors: [["button", "brnDialogTrigger", ""], ["button", "brnDialogTriggerFor", ""]],
    hostAttrs: ["aria-haspopup", "dialog"],
    hostVars: 5,
    hostBindings: function BrnDialogTrigger_HostBindings(rf, ctx) {
      if (rf & 1) {
        ɵɵlistener("click", function BrnDialogTrigger_click_HostBindingHandler() {
          return ctx.open();
        });
      }
      if (rf & 2) {
        ɵɵdomProperty("id", ctx.id())("type", ctx.type());
        ɵɵattribute("aria-expanded", ctx.state() === "open" ? "true" : "false")("data-state", ctx.state())("aria-controls", ctx.dialogId());
      }
    },
    inputs: {
      id: [1, "id"],
      type: [1, "type"],
      brnDialogTriggerFor: [1, "brnDialogTriggerFor"]
    },
    exportAs: ["brnDialogTrigger"]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnDialogTrigger, [{
    type: Directive,
    args: [{
      selector: "button[brnDialogTrigger],button[brnDialogTriggerFor]",
      exportAs: "brnDialogTrigger",
      host: {
        "[id]": "id()",
        "(click)": "open()",
        "aria-haspopup": "dialog",
        "[attr.aria-expanded]": "state() === 'open' ? 'true' : 'false'",
        "[attr.data-state]": "state()",
        "[attr.aria-controls]": "dialogId()",
        "[type]": "type()"
      }
    }]
  }], null, {
    id: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "id",
        required: false
      }]
    }],
    type: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "type",
        required: false
      }]
    }],
    brnDialogTriggerFor: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "brnDialogTriggerFor",
        required: false
      }]
    }]
  });
})();
var BrnDialogImports = [BrnDialog, BrnDialogOverlay, BrnDialogTrigger, BrnDialogClose, BrnDialogContent, BrnDialogTitle, BrnDialogDescription];

export {
  defaultOptions,
  provideBrnDialogDefaultOptions,
  injectBrnDialogDefaultOptions,
  BrnDialogRef,
  injectBrnDialogContext,
  BrnDialogService,
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogOverlay,
  BrnDialogTitle,
  BrnDialogTrigger,
  BrnDialogImports
};
//# sourceMappingURL=chunk-KKDFZHB2.js.map
