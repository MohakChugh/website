import { createRequire } from 'module';const require = createRequire(import.meta.url);
import {
  toObservable,
  toSignal
} from "./chunk-5FASJ265.js";
import {
  isPlatformServer
} from "./chunk-UWNCB2MR.js";
import {
  DestroyRef,
  ElementRef,
  InjectionToken,
  Injector,
  PLATFORM_ID,
  afterNextRender,
  computed,
  forwardRef,
  inject,
  require_cjs,
  require_operators,
  runInInjectionContext,
  signal,
  untracked
} from "./chunk-POAZVYWT.js";
import {
  __toESM
} from "./chunk-6DU2HRTW.js";

// node_modules/@spartan-ng/brain/fesm2022/spartan-ng-brain-core.mjs
var import_rxjs = __toESM(require_cjs(), 1);
var import_operators = __toESM(require_operators(), 1);
function computedPrevious(computation) {
  let current = null;
  let previous = untracked(() => computation());
  return computed(() => {
    current = computation();
    const result = previous;
    previous = current;
    return result;
  });
}
function brnZoneFull(zone) {
  return (source) => new import_rxjs.Observable((subscriber) => source.subscribe({
    next: (value) => zone.run(() => subscriber.next(value)),
    error: (error) => zone.run(() => subscriber.error(error)),
    complete: () => zone.run(() => subscriber.complete())
  }));
}
function brnZoneFree(zone) {
  return (source) => new import_rxjs.Observable((subscriber) => zone.runOutsideAngular(() => source.subscribe(subscriber)));
}
function brnZoneOptimized(zone) {
  return (0, import_rxjs.pipe)(brnZoneFree(zone), brnZoneFull(zone));
}
function movedOut({ currentTarget, relatedTarget }) {
  return !isElement(relatedTarget) || !isElement(currentTarget) || !currentTarget.contains(relatedTarget);
}
function isElement(node) {
  return !!node && "nodeType" in node && node.nodeType === Node.ELEMENT_NODE;
}
var createHoverObservable = (nativeElement, zone, destroyed$) => {
  return (0, import_rxjs.merge)(
    (0, import_rxjs.fromEvent)(nativeElement, "mouseenter").pipe((0, import_operators.map)(() => ({ hover: true }))),
    (0, import_rxjs.fromEvent)(nativeElement, "mouseleave").pipe((0, import_operators.map)((e) => ({ hover: false, relatedTarget: e.relatedTarget }))),
    // Hello, Safari
    (0, import_rxjs.fromEvent)(nativeElement, "mouseout").pipe((0, import_operators.filter)(movedOut), (0, import_operators.map)((e) => ({ hover: false, relatedTarget: e.relatedTarget })))
  ).pipe((0, import_operators.distinctUntilChanged)(), brnZoneOptimized(zone), (0, import_operators.takeUntil)(destroyed$));
};
function cssClassesToArray(classes, defaultClass = "") {
  const value = classes ?? defaultClass;
  return (Array.isArray(value) ? value : [value]).flatMap((className) => className.split(/\s+/).filter(Boolean));
}
function createInjectionToken(description) {
  const token = new InjectionToken(description);
  const provideFn = (value) => {
    return { provide: token, useValue: value };
  };
  const provideExistingFn = (value) => {
    return { provide: token, useExisting: forwardRef(value) };
  };
  const injectFn = (options = {}) => {
    return inject(token, options);
  };
  return [injectFn, provideFn, provideExistingFn, token];
}
var [injectCustomClassSettable, provideCustomClassSettable, provideCustomClassSettableExisting, SET_CLASS_TO_CUSTOM_ELEMENT_TOKEN] = createInjectionToken("@spartan-ng SET_CLASS_TO_CUSTOM_ELEMENT_TOKEN");
function debouncedSignal(source, delay) {
  const source$ = toObservable(source);
  const debounced$ = source$.pipe((0, import_operators.debounceTime)(delay), (0, import_operators.distinctUntilChanged)());
  return toSignal(debounced$, { initialValue: source() });
}
var brnDevMode = ngDevMode;
var [injectExposedSideProvider, provideExposedSideProvider, provideExposedSideProviderExisting, EXPOSES_SIDE_TOKEN] = createInjectionToken("@spartan-ng EXPOSES_SIDE_TOKEN");
var [injectExposesStateProvider, provideExposesStateProvider, provideExposesStateProviderExisting, EXPOSES_STATE_TOKEN] = createInjectionToken("@spartan-ng EXPOSES_STATE_TOKEN");
function injectContentDimensions() {
  const host = inject(ElementRef).nativeElement;
  const platformId = inject(PLATFORM_ID);
  const destroyRef = inject(DestroyRef);
  const width = signal(null, ...ngDevMode ? [{ debugName: "width" }] : (
    /* istanbul ignore next */
    []
  ));
  const height = signal(null, ...ngDevMode ? [{ debugName: "height" }] : (
    /* istanbul ignore next */
    []
  ));
  if (isPlatformServer(platformId)) {
    return { width: width.asReadonly(), height: height.asReadonly() };
  }
  const measure = () => {
    const previousHeight = host.style.height;
    host.style.height = "auto";
    width.set(host.scrollWidth);
    height.set(host.scrollHeight);
    host.style.height = previousHeight;
  };
  afterNextRender({
    read: () => {
      measure();
      if (typeof ResizeObserver === "undefined")
        return;
      let frame = 0;
      const observer = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(measure);
      });
      const content = host.firstElementChild;
      if (content) {
        observer.observe(content);
      }
      destroyRef.onDestroy(() => {
        cancelAnimationFrame(frame);
        observer.disconnect();
      });
    }
  });
  return { width: width.asReadonly(), height: height.asReadonly() };
}
function injectElementSize(options = {}) {
  return runInInjectionContext(options.injector ?? inject(Injector), () => {
    const elementRef = options.elementRef ?? inject(ElementRef);
    const platformId = inject(PLATFORM_ID);
    const destroyRef = inject(DestroyRef);
    const element = elementRef.nativeElement;
    const size = signal(void 0, ...ngDevMode ? [{ debugName: "size" }] : (
      /* istanbul ignore next */
      []
    ));
    if (isPlatformServer(platformId)) {
      return size;
    }
    afterNextRender({
      read: () => {
        const rect = element.getBoundingClientRect();
        size.set({
          width: rect.width || element.offsetWidth,
          height: rect.height || element.offsetHeight
        });
        observerMap.set(element, { element, size });
        getSharedObserver().observe(element, { box: "border-box" });
        destroyRef.onDestroy(() => {
          getSharedObserver().unobserve(element);
          observerMap.delete(element);
          if (observerMap.size === 0 && sharedObserver) {
            sharedObserver.disconnect();
            sharedObserver = void 0;
          }
        });
      }
    });
    return size.asReadonly();
  });
}
var observerMap = /* @__PURE__ */ new Map();
var sharedObserver;
function getSharedObserver() {
  if (!sharedObserver) {
    sharedObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target;
        const entryData = observerMap.get(el);
        if (!entryData)
          continue;
        let width;
        let height;
        if ("borderBoxSize" in entry) {
          const borderSize = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize;
          width = borderSize.inlineSize;
          height = borderSize.blockSize;
        } else {
          width = el.offsetWidth;
          height = el.offsetHeight;
        }
        entryData.size.set({ width, height });
      }
    });
  }
  return sharedObserver;
}
var OPPOSITE_SIDE = { top: "bottom", bottom: "top", left: "right", right: "left" };
var MENU_SIDE = new InjectionToken("SpartanMenuSide");
var deriveMenuSideFromTransformOrigin = (transformOrigin, side) => {
  const [x, y] = transformOrigin.trim().split(/\s+/);
  const anchor = side === "top" || side === "bottom" ? y : x;
  return OPPOSITE_SIDE[anchor] ?? side;
};
var createMenuPosition = (align, side) => {
  const verticalAlign = align === "start" ? "top" : align === "end" ? "bottom" : "center";
  const createPositions = (originX, originY, overlayX, overlayY) => [
    { originX, originY, overlayX, overlayY },
    { originX: overlayX, originY: overlayY, overlayX: originX, overlayY: originY }
  ];
  switch (side) {
    case "top":
      return createPositions(align, "top", align, "bottom");
    case "bottom":
      return createPositions(align, "bottom", align, "top");
    case "left":
      return createPositions("start", verticalAlign, "end", verticalAlign);
    case "right":
      return createPositions("end", verticalAlign, "start", verticalAlign);
  }
};
function stringifyAsLabel(item, itemToStringLabel) {
  if (itemToStringLabel && item !== null && item !== void 0) {
    return itemToStringLabel(item) ?? "";
  }
  if (item && typeof item === "object") {
    if ("label" in item && item.label !== null && item.label !== void 0) {
      return String(item.label);
    }
    if ("value" in item && item.value !== null && item.value !== void 0) {
      return String(item.value);
    }
  }
  return serializeValue(item);
}
function serializeValue(value) {
  if (value === null || value === void 0) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
function injectSkipDelay(skipDelayDuration) {
  const isOpenDelayed = signal(true, ...ngDevMode ? [{ debugName: "isOpenDelayed" }] : (
    /* istanbul ignore next */
    []
  ));
  let timer;
  inject(DestroyRef).onDestroy(() => clearTimeout(timer));
  return {
    isOpenDelayed: isOpenDelayed.asReadonly(),
    open() {
      clearTimeout(timer);
      if (skipDelayDuration() > 0)
        isOpenDelayed.set(false);
    },
    close() {
      clearTimeout(timer);
      const duration = skipDelayDuration();
      if (duration > 0) {
        timer = setTimeout(() => isOpenDelayed.set(true), duration);
      }
    }
  };
}
var [injectTableClassesSettable, provideTableClassesSettable, provideTableClassesSettableExisting, SET_TABLE_CLASSES_TOKEN] = createInjectionToken("@spartan-ng SET_TABLE_CLASSES_TOKEN");
var MAX_ANIMATION_WAIT_MS = 5e3;
var ANIMATION_WAIT_BUFFER_MS = 50;
function getActiveElementAnimations(elements) {
  return elements.filter((element) => !!element).flatMap((element) => typeof element.getAnimations === "function" ? element.getAnimations({ subtree: true }).filter((animation) => animation.playState !== "finished") : []);
}
async function waitForAnimations(animations) {
  if (!animations.length)
    return;
  let timeout;
  const fallbackMs = getFallbackTimeout(animations);
  try {
    await Promise.race([
      Promise.allSettled(animations.map((animation) => animation.finished)),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, fallbackMs);
      })
    ]);
  } finally {
    if (timeout)
      clearTimeout(timeout);
  }
}
async function waitForElementAnimations(element) {
  await waitForAnimations(getActiveElementAnimations([element]));
}
function getFallbackTimeout(animations) {
  const longestAnimation = animations.reduce((longest, animation) => {
    const endTime = animation.effect?.getComputedTiming().endTime;
    return typeof endTime === "number" && Number.isFinite(endTime) ? Math.max(longest, endTime) : longest;
  }, 0);
  if (!longestAnimation)
    return MAX_ANIMATION_WAIT_MS;
  return Math.min(longestAnimation + ANIMATION_WAIT_BUFFER_MS, MAX_ANIMATION_WAIT_MS);
}

export {
  computedPrevious,
  brnZoneFull,
  brnZoneFree,
  brnZoneOptimized,
  isElement,
  createHoverObservable,
  cssClassesToArray,
  injectCustomClassSettable,
  provideCustomClassSettable,
  provideCustomClassSettableExisting,
  SET_CLASS_TO_CUSTOM_ELEMENT_TOKEN,
  debouncedSignal,
  brnDevMode,
  injectExposedSideProvider,
  provideExposedSideProvider,
  provideExposedSideProviderExisting,
  EXPOSES_SIDE_TOKEN,
  injectExposesStateProvider,
  provideExposesStateProvider,
  provideExposesStateProviderExisting,
  EXPOSES_STATE_TOKEN,
  injectContentDimensions,
  injectElementSize,
  MENU_SIDE,
  deriveMenuSideFromTransformOrigin,
  createMenuPosition,
  stringifyAsLabel,
  serializeValue,
  injectSkipDelay,
  injectTableClassesSettable,
  provideTableClassesSettable,
  provideTableClassesSettableExisting,
  SET_TABLE_CLASSES_TOKEN,
  getActiveElementAnimations,
  waitForAnimations,
  waitForElementAnimations
};
//# sourceMappingURL=chunk-6RCBT6RK.js.map
