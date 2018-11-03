// TODO: Symbol polyfill?
export const yieldableSymbol = "__ec_yieldable__";
export const YIELDABLE_CONTINUE = "next";
export const YIELDABLE_THROW = "throw";
export const YIELDABLE_RETURN = "return";
export const YIELDABLE_CANCEL = "cancel";

export function RawValue(value) {
  this.value = value;
}

export function raw(value) {
  return new RawValue(value);
}
