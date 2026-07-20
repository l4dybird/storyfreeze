/*
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Modified by StoryFreeze to retain only names and viewport compatibility data
 * and to generate landscape variants from the Puppeteer 9.1.1 descriptors.
 */

import type { Viewport } from '../shared/types.js';

export interface BrowserDeviceDescriptor {
  name: string;
  viewport: Viewport;
}

const portraitDevices = [
  ['Blackberry PlayBook', 600, 1024, 1],
  ['BlackBerry Z30', 360, 640, 2],
  ['Galaxy Note 3', 360, 640, 3],
  ['Galaxy Note II', 360, 640, 2],
  ['Galaxy S III', 360, 640, 2],
  ['Galaxy S5', 360, 640, 3],
  ['iPad', 768, 1024, 2],
  ['iPad Mini', 768, 1024, 2],
  ['iPad Pro', 1024, 1366, 2],
  ['iPhone 4', 320, 480, 2],
  ['iPhone 5', 320, 568, 2],
  ['iPhone 6', 375, 667, 2],
  ['iPhone 6 Plus', 414, 736, 3],
  ['iPhone 7', 375, 667, 2],
  ['iPhone 7 Plus', 414, 736, 3],
  ['iPhone 8', 375, 667, 2],
  ['iPhone 8 Plus', 414, 736, 3],
  ['iPhone SE', 320, 568, 2],
  ['iPhone X', 375, 812, 3],
  ['iPhone XR', 414, 896, 3],
  ['iPhone 11', 414, 828, 2],
  ['iPhone 11 Pro', 375, 812, 3],
  ['iPhone 11 Pro Max', 414, 896, 3],
  ['JioPhone 2', 240, 320, 1],
  ['Kindle Fire HDX', 800, 1280, 2],
  ['LG Optimus L70', 384, 640, 1.25],
  ['Microsoft Lumia 550', 640, 360, 2],
  ['Microsoft Lumia 950', 360, 640, 4],
  ['Nexus 10', 800, 1280, 2],
  ['Nexus 4', 384, 640, 2],
  ['Nexus 5', 360, 640, 3],
  ['Nexus 5X', 412, 732, 2.625],
  ['Nexus 6', 412, 732, 3.5],
  ['Nexus 6P', 412, 732, 3.5],
  ['Nexus 7', 600, 960, 2],
  ['Nokia Lumia 520', 320, 533, 1.5],
  ['Nokia N9', 480, 854, 1],
  ['Pixel 2', 411, 731, 2.625],
  ['Pixel 2 XL', 411, 823, 3.5],
] as const;

export const browserDeviceDescriptors: readonly BrowserDeviceDescriptor[] = portraitDevices.flatMap(
  ([name, width, height, deviceScaleFactor]) => {
    const portrait: BrowserDeviceDescriptor = {
      name,
      viewport: { width, height, deviceScaleFactor, isMobile: true, hasTouch: true, isLandscape: false },
    };
    if (name === 'Microsoft Lumia 550') return [portrait];
    return [
      portrait,
      {
        name: `${name} landscape`,
        viewport: {
          width: height,
          height: width,
          deviceScaleFactor,
          isMobile: true,
          hasTouch: true,
          isLandscape: true,
        },
      },
    ];
  },
);
