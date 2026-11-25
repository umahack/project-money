import { Capacitor } from '@capacitor/core';

/** The only application module that calls Capacitor.isNativePlatform(). */
export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}
