import { Linking, Platform } from "react-native";

/** Hand turn-by-turn driving directions to the platform's maps app, falling back to the web. Fire and forget. */
export function openDirections(lat: number, lon: number, label: string): void {
  const ll = `${lat},${lon}`;
  const web = `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`;
  const urls = Platform.OS === "ios"
    ? [`http://maps.apple.com/?daddr=${ll}&dirflg=d`, web]
    : Platform.OS === "android"
      // geo: works without Google Maps installed and at least shows the labelled pin
      ? [`google.navigation:q=${ll}`, `geo:${ll}?q=${ll}(${encodeURIComponent(label)})`, web]
      : [web];
  const tryNext = (i: number): void => {
    if (i >= urls.length) return;
    Linking.openURL(urls[i]).catch(() => tryNext(i + 1));
  };
  tryNext(0);
}
