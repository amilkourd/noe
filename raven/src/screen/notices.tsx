import { useMemo } from "react";
import { AccessibilityInfo, View } from "react-native";
import { Toast, useToast } from "heroui-native";

type Tone = "sage" | "ember";

// Custom toast body: HeroUI's soft success/danger label colors are too pale on the cream overlay,
// so the text stays coal/taupe and the tone rides on a small dot.
export function useNotice() {
  const { toast } = useToast();
  return useMemo(() => {
    const show = (tone: Tone, label: string, description?: string, id?: string) => {
      AccessibilityInfo.announceForAccessibility(description ? `${label}. ${description}` : label);
      toast.show({
        id,
        duration: tone === "ember" ? 6000 : 4000,
        component: (props) => (
          <Toast {...props} variant={tone === "ember" ? "danger" : "success"} className="flex-row items-center gap-3 rounded-[28px] px-5 py-4">
            <View className={tone === "ember" ? "h-2 w-2 rounded-full bg-ember" : "h-2 w-2 rounded-full bg-sage"} />
            <View className="flex-1">
              <Toast.Title className="font-medium text-[15px] text-coal">{label}</Toast.Title>
              {description ? (
                <Toast.Description className="mt-0.5 font-normal text-[13px] text-taupe">{description}</Toast.Description>
              ) : null}
            </View>
          </Toast>
        ),
      });
    };
    return {
      done: (label: string, id: string) => show("sage", label, undefined, id),
      fail: (label: string, message: string) => show("ember", label, message),
    };
  }, [toast]);
}
