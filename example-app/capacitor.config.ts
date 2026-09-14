import type { CapacitorConfig } from '@capacitor/cli';

import pkg from './package.json';

const config: CapacitorConfig = {
  appId: 'com.capgo.backgroundgeolocation.example',
  appName: '@capgo/background-geolocation',
  webDir: 'dist',
  android: {
    useLegacyBridge: true,
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
    },
    CapacitorUpdater: {
      appId: 'com.capgo.backgroundgeolocation.example',
      autoUpdate: false,
      autoSplashscreen: false,
      directUpdate: 'always',
      version: pkg.version,
    },
  },
};

export default config;
