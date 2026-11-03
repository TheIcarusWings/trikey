// Types for android-variant.js (CommonJS, so that metro.config.js, react-native.config.js and the config plugin can
// require it without a compiler).
export type AndroidVariant = 'standard' | 'foss';
export declare const ANDROID_VARIANTS: readonly AndroidVariant[];
export declare const FOSS_UNLINKED_LIBRARIES: string[];
export declare const UNLINKED_EXPO_MODULES: Record<AndroidVariant, string[]>;
export declare const FOSS_FORBIDDEN_PACKAGES: string[];
export declare const FOSS_EXCLUDED_MAVEN_MODULES: { group: string; module: string }[];
export declare function androidVariant(env?: Record<string, string | undefined>): AndroidVariant;
