import localFont from "next/font/local";

export const mdUi = localFont({
  src: "./fonts/MDUI-VF.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  variable: "--font-md-ui",
  fallback: ["Arial", "sans-serif"],
});

export const mdUiXs = localFont({
  src: [
    { path: "./fonts/MDUIXS-Light.woff2", weight: "300", style: "normal" },
    { path: "./fonts/MDUIXS-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/MDUIXS-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/MDUIXS-Semibold.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
  preload: false,
  variable: "--font-md-ui-xs",
  fallback: ["Arial", "sans-serif"],
});

export const mdUiXl = localFont({
  src: [
    { path: "./fonts/MDUIXL-Light.woff2", weight: "300", style: "normal" },
    { path: "./fonts/MDUIXL-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/MDUIXL-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/MDUIXL-Semibold.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
  preload: false,
  variable: "--font-md-ui-xl",
  fallback: ["Arial", "sans-serif"],
});

export const mdIo = localFont({
  src: "./fonts/MDIO-VF.woff2",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: false,
  variable: "--font-md-io",
  fallback: ["Courier New", "monospace"],
});
