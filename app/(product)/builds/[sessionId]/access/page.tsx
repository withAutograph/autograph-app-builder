import { AppAccessPage } from "@/app/ui/app-access";
import { continueBuilderAppAccess } from "@/app/actions/app-access";

export default async function SavedAppAccessPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  return (
    <AppAccessPage
      key={sessionId}
      sessionId={sessionId}
      continueAction={continueBuilderAppAccess}
    />
  );
}
