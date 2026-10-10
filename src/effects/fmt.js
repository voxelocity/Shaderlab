// Value formatters for param badges.
export const pct = v => `${Math.round(v * 100)}%`;
export const px = v => `${+(+v).toFixed(v % 1 ? 1 : 0)}px`;
export const deg = v => `${Math.round(v)}°`;
export const times = v => `${(+v).toFixed(2)}×`;
export const fixed = (d = 2) => v => (+v).toFixed(d);
export const int = v => `${Math.round(v)}`;
