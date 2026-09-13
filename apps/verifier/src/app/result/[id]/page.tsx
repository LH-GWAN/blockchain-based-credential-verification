import { ResultView } from "@/components/ResultView";

export default async function ResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ResultView requestId={id} />;
}
