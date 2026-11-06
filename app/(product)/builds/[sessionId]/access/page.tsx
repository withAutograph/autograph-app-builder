import { AppAccessPage } from "@/app/ui/app-access";
import { continueBuilderAppAccess } from "@/app/actions/app-access";
import { Suspense } from "react";

const SavedAppAccess = async ({ params }: { params: Promise<{ sessionId: string }> }) => {
  const { sessionId } = await params;
  return (
    <AppAccessPage
      key={sessionId}
      sessionId={sessionId}
      continueAction={continueBuilderAppAccess}
    />
  );
};

export default function SavedAppAccessPage(props: { params: Promise<{ sessionId: string }> }) {
  return (
    <Suspense fallback={<p role="status">Loading app access…</p>}>
      <SavedAppAccess {...props} />
    </Suspense>
  );
}
