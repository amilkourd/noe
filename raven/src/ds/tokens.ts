// Hex mirror of the palette in global.css, for places classNames can't reach (SVG, maps, haptics UI).
export const color = {
  ink: "#000000",
  inkRaised: "#141414",
  pill: "#303030",
  pillActive: "#484848",
  pillFaint: "#5a5a5a",
  tick: "#3d3d3d",
  ash: "#949089",
  paper: "#f2eee9",
  cream: "#e8e5dd",
  creamDeep: "#dedad1",
  creamLine: "#d2cdc3",
  taupe: "#66615a",
  coal: "#262626",
  mauve: "#706161",
  cocoa: "#322f2e",
  ember: "#e07a5f",
  water: "#8fb3c4",
  sage: "#a3b79c",
} as const;

export const font = {
  hair: "Jost_200ExtraLight",
  light: "Jost_300Light",
  normal: "Jost_400Regular",
  medium: "Jost_500Medium",
  semibold: "Jost_600SemiBold",
  bold: "Jost_700Bold",
} as const;
