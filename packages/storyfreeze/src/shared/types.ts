type $Strict<T> = {
  [P in keyof T]-?: T[P];
};

/** Browser-neutral Chromium viewport and device-emulation settings. */
export type Viewport = {
  /** Viewport width in CSS pixels. */
  width: number;
  /** Viewport height in CSS pixels. */
  height: number;
  /** Device pixel ratio used for the capture. */
  deviceScaleFactor?: number;
  /** Whether Chromium should emulate a mobile viewport. */
  isMobile?: boolean;
  /** Whether Chromium should emulate touch input. */
  hasTouch?: boolean;
  /** Whether the emulated device is in landscape orientation. */
  isLandscape?: boolean;
};

/** Screenshot settings shared by root options and variants. */
export interface ScreenshotOptionFragments {
  delay?: number;
  waitAssets?: boolean;
  /** @deprecated Use `waitAssets`. */
  waitImages?: boolean;
  waitFor?: string | (() => Promise<unknown>);
  viewport?: Viewport | string;
  fullPage?: boolean;
  hover?: string;
  focus?: string;
  click?: string;
  skip?: boolean;
  omitBackground?: boolean;
  captureBeyondViewport?: boolean;
  clip?: { x: number; y: number; width: number; height: number } | null;
}

/** Screenshot settings accepted by one named variant. */
export interface ScreenshotOptionFragmentsForVariant extends ScreenshotOptionFragments {
  /** Parent variants whose settings are merged before this variant. */
  extends?: string | string[];
}

/** Named screenshot variants for one story. */
export type Variants = Record<string, ScreenshotOptionFragmentsForVariant>;

export interface StorySessionResetContext {
  storyId: string;
  variantId: string;
}

/**
 *
 * Represents a root(default) screenshot options.
 *
 **/
export interface ScreenshotOptions extends ScreenshotOptionFragments {
  viewports?: string[] | { [key: string]: string | Viewport };
  variants?: Variants;
  defaultVariantSuffix?: string;
  /** Cleans up story-owned state after each non-default variant capture. */
  reset?: (context: StorySessionResetContext) => void | Promise<void>;
}

export interface StrictScreenshotOptions extends $Strict<ScreenshotOptionFragments> {
  variants: {
    [key: string]: $Strict<ScreenshotOptionFragmentsForVariant>;
  };
  defaultVariantSuffix: string;
}

/**
 *
 * Represents an identifier for a variant.
 *
 * @remarks
 *
 * - If `isDefault` is set, this variant key means the variant is the root(default) variant.
 * - `keys` holds the names of variants in the order closest to root.
 *
 **/
export type VariantKey = {
  isDefault: boolean;
  keys: string[];
};

export interface Exposed {
  getBaseScreenshotOptions(): StrictScreenshotOptions;
  getCurrentVariantKey(): VariantKey;
}
