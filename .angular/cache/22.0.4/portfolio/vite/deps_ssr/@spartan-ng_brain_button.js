import { createRequire } from 'module';const require = createRequire(import.meta.url);
import {
  takeUntilDestroyed
} from "./chunk-5FASJ265.js";
import {
  Directive,
  ElementRef,
  HOST_TAG_NAME,
  Input,
  booleanAttribute,
  inject,
  input,
  require_cjs,
  require_operators,
  setClassMetadata,
  ɵɵattribute,
  ɵɵdefineDirective
} from "./chunk-POAZVYWT.js";
import {
  __spreadProps,
  __spreadValues,
  __toESM
} from "./chunk-6DU2HRTW.js";

// node_modules/@spartan-ng/brain/fesm2022/spartan-ng-brain-button.mjs
var import_rxjs = __toESM(require_cjs(), 1);
var import_operators = __toESM(require_operators(), 1);
var BrnButton = class _BrnButton {
  disabled = input(false, __spreadProps(__spreadValues({}, ngDevMode ? {
    debugName: "disabled"
  } : (
    /* istanbul ignore next */
    {}
  )), {
    transform: booleanAttribute
  }));
  _isAnchor = inject(HOST_TAG_NAME) === "a";
  _elementRef = inject(ElementRef);
  constructor() {
    if (this._isAnchor) {
      (0, import_rxjs.fromEvent)(this._elementRef.nativeElement, "click").pipe((0, import_operators.filter)(() => this.disabled()), takeUntilDestroyed()).subscribe((event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      });
    }
  }
  /** @nocollapse */
  static ɵfac = function BrnButton_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _BrnButton)();
  };
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnButton,
    selectors: [["a", "brnButton", ""], ["button", "brnButton", ""]],
    hostVars: 3,
    hostBindings: function BrnButton_HostBindings(rf, ctx) {
      if (rf & 2) {
        ɵɵattribute("tabindex", ctx.disabled() ? -1 : void 0)("disabled", !ctx._isAnchor && ctx.disabled() || null)("data-disabled", ctx.disabled() || null);
      }
    },
    inputs: {
      disabled: [1, "disabled"]
    }
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnButton, [{
    type: Directive,
    args: [{
      selector: "a[brnButton], button[brnButton]",
      host: {
        "[attr.tabindex]": "disabled() ? -1 : undefined",
        "[attr.disabled]": "!_isAnchor && disabled() || null",
        "[attr.data-disabled]": "disabled() || null"
      }
    }]
  }], () => [], {
    disabled: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "disabled",
        required: false
      }]
    }]
  });
})();
var BrnButtonImports = [BrnButton];
export {
  BrnButton,
  BrnButtonImports
};
//# sourceMappingURL=@spartan-ng_brain_button.js.map
