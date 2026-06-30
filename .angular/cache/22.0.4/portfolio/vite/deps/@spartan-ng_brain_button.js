import {
  takeUntilDestroyed
} from "./chunk-6QNWAMQG.js";
import {
  Directive,
  ElementRef,
  HOST_TAG_NAME,
  Input,
  booleanAttribute,
  filter,
  fromEvent,
  inject,
  input,
  setClassMetadata,
  ɵɵattribute,
  ɵɵdefineDirective
} from "./chunk-4FXLZEUY.js";
import {
  __spreadProps,
  __spreadValues
} from "./chunk-H2SRQSE4.js";

// node_modules/@spartan-ng/brain/fesm2022/spartan-ng-brain-button.mjs
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
      fromEvent(this._elementRef.nativeElement, "click").pipe(filter(() => this.disabled()), takeUntilDestroyed()).subscribe((event) => {
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
