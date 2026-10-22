/// <reference types="expo/types" />
// (what a generated expo-env.d.ts would carry: it declares the *.css side-effect import below)
import "./global.css";

import { StatusBar } from "expo-status-bar";
import { Platform, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, initialWindowMetrics } from "react-native-safe-area-context";
import { HeroUINativeProvider, type HeroUINativeConfig } from "heroui-native";
import { Uniwind } from "uniwind";
import {
  useFonts, Jost_200ExtraLight, Jost_300Light, Jost_400Regular, Jost_500Medium, Jost_600SemiBold, Jost_700Bold,
} from "@expo-google-fonts/jost";
import { color } from "./src/ds/tokens";
import { RavenScreen } from "./src/screen/RavenScreen";

Uniwind.setTheme("dark");

const config: HeroUINativeConfig = {
  // the instrument and card are laid out for fixed type sizes: let accessibility text grow, within reason
  textProps: { maxFontSizeMultiplier: 1.3 },
  devInfo: { stylingPrinciples: false },
  // top: the header is the least critical strip; the card's actions stay reachable
  toast: { defaultProps: { placement: "top" }, maxVisibleToasts: 2 },
};

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    Jost_200ExtraLight, Jost_300Light, Jost_400Regular, Jost_500Medium, Jost_600SemiBold, Jost_700Bold,
  });
  // a font failure falls back to the system font rather than a blank screen in the field
  if (!fontsLoaded && !fontError) return <View className="flex-1 bg-ink" />;
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: color.ink }}>
      {/* HeroUI's toast insets and the screen layout read useSafeAreaInsets, which needs the provider */}
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <HeroUINativeProvider config={config}>
          <StatusBar style="light" />
          {/* on the web the phone layout is kept, centered on wide screens */}
          {Platform.OS === "web" ? (
            <View style={{ flex: 1, width: "100%", maxWidth: 480, alignSelf: "center" }}><RavenScreen /></View>
          ) : <RavenScreen />}
        </HeroUINativeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
