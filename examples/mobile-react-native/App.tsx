// SPDX-License-Identifier: Apache-2.0
// A one-screen Expo app that reports two named events to UsageMap: `app_open` on start and `swap_started` on a tap.
// The queue is flushed when the app goes to the background. No device id, user id or address exists in the API.
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState, Button, Platform, StyleSheet, Text, View } from "react-native";
import { createUsageMapApp } from "./usagemap";

// UsageMap: one instance for the whole app (site key from the portal: Project → Websites)
export const analytics = createUsageMapApp({
  siteKey: process.env.EXPO_PUBLIC_USAGEMAP_SITE ?? "YOUR_22_CHAR_SITE_KEY",
  platform: Platform.OS === "ios" ? "ios" : "android",
  appVersion: "1.0.0",
  endpoint: process.env.EXPO_PUBLIC_USAGEMAP_ENDPOINT, // default: https://e1.usagemap.dev/v1/app-events
});

export default function App() {
  useEffect(() => {
    analytics.track("app_open");
    const sub = AppState.addEventListener("change", (s) => s === "background" && analytics.flush());
    return () => sub.remove();
  }, []);

  return (
    <View style={styles.container}>
      <Text>UsageMap app events</Text>
      <Button
        title="Start a swap"
        onPress={() => analytics.track("swap_started", { pair_class: "stablecoin" })}
      />
      <Button title="Send now" onPress={() => analytics.flush()} />
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 },
});
