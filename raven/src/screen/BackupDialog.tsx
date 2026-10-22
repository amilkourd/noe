import { View } from "react-native";
import { Dialog } from "heroui-native";
import { ActionButton } from "../ds";

interface Props {
  isOpen: boolean;
  targetName: string;
  isLoading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

// Controlled (no Trigger): the BACKUP corner button on the mission card opens it.
// While the request is in flight it can't be dismissed, so the spinner stays where the tap was.
export function BackupDialog({ isOpen, targetName, isLoading, onClose, onConfirm }: Props) {
  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => { if (!open && !isLoading) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay isCloseOnPress={!isLoading} />
        <Dialog.Content isSwipeable={!isLoading} className="rounded-[36px] px-6 pb-6 pt-7">
          <Dialog.Title className="text-center font-semibold text-[24px] text-coal">Request backup?</Dialog.Title>
          <Dialog.Description className="mt-2 text-center font-normal text-[14px] text-taupe">
            {`NOÉ will send another team to ${targetName}.`}
          </Dialog.Description>
          <View className="mt-6 flex-row gap-3">
            <View className="flex-1">
              <ActionButton label="Cancel" variant="secondary" block onPress={onClose} isDisabled={isLoading} />
            </View>
            <View className="flex-1">
              <ActionButton label="Request" variant="danger" block onPress={onConfirm} isLoading={isLoading} />
            </View>
          </View>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  );
}
