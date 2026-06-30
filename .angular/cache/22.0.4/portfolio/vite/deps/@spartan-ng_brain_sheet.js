import {
  BrnDialog,
  BrnDialogClose,
  BrnDialogContent,
  BrnDialogDescription,
  BrnDialogOverlay,
  BrnDialogTitle,
  BrnDialogTrigger
} from "./chunk-KKDFZHB2.js";
import {
  provideCustomClassSettableExisting,
  provideExposedSideProviderExisting,
  provideExposesStateProviderExisting
} from "./chunk-MAJBEXLM.js";
import "./chunk-JGRVC4C7.js";
import "./chunk-QOAZVKZ4.js";
import "./chunk-5CYKHHIP.js";
import "./chunk-DP4RKSM7.js";
import "./chunk-Y36MECYX.js";
import "./chunk-R6W3E7W4.js";
import {
  Directive,
  Input,
  forwardRef,
  inject,
  input,
  linkedSignal,
  setClassMetadata,
  ɵɵHostDirectivesFeature,
  ɵɵInheritDefinitionFeature,
  ɵɵProvidersFeature,
  ɵɵdefineDirective,
  ɵɵgetInheritedFactory
} from "./chunk-55R2KRJF.js";
import "./chunk-GOMI4DH3.js";

// node_modules/@spartan-ng/brain/fesm2022/spartan-ng-brain-sheet.mjs
var BrnSheet = class _BrnSheet extends BrnDialog {
  /** Specifies the side of the screen where the sheet will appear. */
  side = input("top", ...ngDevMode ? [{
    debugName: "side"
  }] : (
    /* istanbul ignore next */
    []
  ));
  sideState = linkedSignal(this.side, ...ngDevMode ? [{
    debugName: "sideState"
  }] : (
    /* istanbul ignore next */
    []
  ));
  getPositionStrategy() {
    switch (this.sideState()) {
      case "bottom":
        return this._positionBuilder.global().bottom();
      case "left":
        return this._positionBuilder.global().left();
      case "right":
        return this._positionBuilder.global().right();
      case "top":
        return this._positionBuilder.global().top();
    }
  }
  /** @nocollapse */
  static ɵfac = /* @__PURE__ */ (() => {
    let ɵBrnSheet_BaseFactory;
    return function BrnSheet_Factory(__ngFactoryType__) {
      return (ɵBrnSheet_BaseFactory || (ɵBrnSheet_BaseFactory = ɵɵgetInheritedFactory(_BrnSheet)))(__ngFactoryType__ || _BrnSheet);
    };
  })();
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnSheet,
    selectors: [["", "brnSheet", ""], ["brn-sheet"]],
    inputs: {
      side: [1, "side"]
    },
    exportAs: ["brnSheet"],
    features: [ɵɵProvidersFeature([{
      provide: BrnDialog,
      useExisting: forwardRef(() => _BrnSheet)
    }]), ɵɵInheritDefinitionFeature]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnSheet, [{
    type: Directive,
    args: [{
      selector: "[brnSheet],brn-sheet",
      exportAs: "brnSheet",
      providers: [{
        provide: BrnDialog,
        useExisting: forwardRef(() => BrnSheet)
      }]
    }]
  }], null, {
    side: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "side",
        required: false
      }]
    }]
  });
})();
var BrnSheetClose = class _BrnSheetClose extends BrnDialogClose {
  /** @nocollapse */
  static ɵfac = /* @__PURE__ */ (() => {
    let ɵBrnSheetClose_BaseFactory;
    return function BrnSheetClose_Factory(__ngFactoryType__) {
      return (ɵBrnSheetClose_BaseFactory || (ɵBrnSheetClose_BaseFactory = ɵɵgetInheritedFactory(_BrnSheetClose)))(__ngFactoryType__ || _BrnSheetClose);
    };
  })();
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnSheetClose,
    selectors: [["button", "brnSheetClose", ""]],
    features: [ɵɵInheritDefinitionFeature]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnSheetClose, [{
    type: Directive,
    args: [{
      selector: "button[brnSheetClose]"
    }]
  }], null, null);
})();
var BrnSheetContent = class _BrnSheetContent extends BrnDialogContent {
  side = inject(BrnSheet).sideState;
  /** @nocollapse */
  static ɵfac = /* @__PURE__ */ (() => {
    let ɵBrnSheetContent_BaseFactory;
    return function BrnSheetContent_Factory(__ngFactoryType__) {
      return (ɵBrnSheetContent_BaseFactory || (ɵBrnSheetContent_BaseFactory = ɵɵgetInheritedFactory(_BrnSheetContent)))(__ngFactoryType__ || _BrnSheetContent);
    };
  })();
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnSheetContent,
    selectors: [["", "brnSheetContent", ""]],
    features: [ɵɵProvidersFeature([provideExposesStateProviderExisting(() => _BrnSheetContent), provideExposedSideProviderExisting(() => _BrnSheetContent)]), ɵɵInheritDefinitionFeature]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnSheetContent, [{
    type: Directive,
    args: [{
      selector: "[brnSheetContent]",
      providers: [provideExposesStateProviderExisting(() => BrnSheetContent), provideExposedSideProviderExisting(() => BrnSheetContent)]
    }]
  }], null, null);
})();
var BrnSheetDescription = class _BrnSheetDescription {
  /** @nocollapse */
  static ɵfac = function BrnSheetDescription_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _BrnSheetDescription)();
  };
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnSheetDescription,
    selectors: [["", "brnSheetDescription", ""]],
    features: [ɵɵHostDirectivesFeature([BrnDialogDescription])]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnSheetDescription, [{
    type: Directive,
    args: [{
      selector: "[brnSheetDescription]",
      hostDirectives: [BrnDialogDescription]
    }]
  }], null, null);
})();
var BrnSheetOverlay = class _BrnSheetOverlay extends BrnDialogOverlay {
  /** @nocollapse */
  static ɵfac = /* @__PURE__ */ (() => {
    let ɵBrnSheetOverlay_BaseFactory;
    return function BrnSheetOverlay_Factory(__ngFactoryType__) {
      return (ɵBrnSheetOverlay_BaseFactory || (ɵBrnSheetOverlay_BaseFactory = ɵɵgetInheritedFactory(_BrnSheetOverlay)))(__ngFactoryType__ || _BrnSheetOverlay);
    };
  })();
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnSheetOverlay,
    selectors: [["", "brnSheetOverlay", ""], ["brn-sheet-overlay"]],
    features: [ɵɵProvidersFeature([provideCustomClassSettableExisting(() => _BrnSheetOverlay)]), ɵɵInheritDefinitionFeature]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnSheetOverlay, [{
    type: Directive,
    args: [{
      selector: "[brnSheetOverlay],brn-sheet-overlay",
      providers: [provideCustomClassSettableExisting(() => BrnSheetOverlay)]
    }]
  }], null, null);
})();
var BrnSheetTitle = class _BrnSheetTitle {
  /** @nocollapse */
  static ɵfac = function BrnSheetTitle_Factory(__ngFactoryType__) {
    return new (__ngFactoryType__ || _BrnSheetTitle)();
  };
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnSheetTitle,
    selectors: [["", "brnSheetTitle", ""]],
    features: [ɵɵHostDirectivesFeature([BrnDialogTitle])]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnSheetTitle, [{
    type: Directive,
    args: [{
      selector: "[brnSheetTitle]",
      hostDirectives: [BrnDialogTitle]
    }]
  }], null, null);
})();
var BrnSheetTrigger = class _BrnSheetTrigger extends BrnDialogTrigger {
  _sheet = inject(BrnSheet, {
    optional: true
  });
  /** Override the side from where the sheet appears for this trigger. */
  side = input(void 0, ...ngDevMode ? [{
    debugName: "side"
  }] : (
    /* istanbul ignore next */
    []
  ));
  open() {
    const side = this.side();
    if (this._sheet && side) {
      this._sheet.sideState.set(side);
    }
    super.open();
  }
  /** @nocollapse */
  static ɵfac = /* @__PURE__ */ (() => {
    let ɵBrnSheetTrigger_BaseFactory;
    return function BrnSheetTrigger_Factory(__ngFactoryType__) {
      return (ɵBrnSheetTrigger_BaseFactory || (ɵBrnSheetTrigger_BaseFactory = ɵɵgetInheritedFactory(_BrnSheetTrigger)))(__ngFactoryType__ || _BrnSheetTrigger);
    };
  })();
  /** @nocollapse */
  static ɵdir = ɵɵdefineDirective({
    type: _BrnSheetTrigger,
    selectors: [["button", "brnSheetTrigger", ""]],
    inputs: {
      side: [1, "side"]
    },
    features: [ɵɵInheritDefinitionFeature]
  });
};
(() => {
  (typeof ngDevMode === "undefined" || ngDevMode) && setClassMetadata(BrnSheetTrigger, [{
    type: Directive,
    args: [{
      selector: "button[brnSheetTrigger]"
    }]
  }], null, {
    side: [{
      type: Input,
      args: [{
        isSignal: true,
        alias: "side",
        required: false
      }]
    }]
  });
})();
var BrnSheetImports = [BrnSheet, BrnSheetOverlay, BrnSheetTrigger, BrnSheetClose, BrnSheetContent, BrnSheetTitle, BrnSheetDescription];
export {
  BrnSheet,
  BrnSheetClose,
  BrnSheetContent,
  BrnSheetDescription,
  BrnSheetImports,
  BrnSheetOverlay,
  BrnSheetTitle,
  BrnSheetTrigger
};
//# sourceMappingURL=@spartan-ng_brain_sheet.js.map
