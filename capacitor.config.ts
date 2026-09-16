const serverUrl = process.env["CAPACITOR_SERVER_URL"];

const config = {
  appId: "pro.moviliza.app",
  appName: "MOVILIZA PRO",
  webDir: "public",
  server: {
    androidScheme: "https",
    iosScheme: "https",
    ...(serverUrl ? { url: serverUrl } : {}),
  },
  android: {
    allowMixedContent: false,
  },
};

export default config;
