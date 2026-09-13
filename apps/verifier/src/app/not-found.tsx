import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card flex flex-col items-start gap-3">
      <h1 className="text-2xl font-bold">페이지를 찾을 수 없습니다</h1>
      <Link href="/" className="btn btn-primary">
        요청 만들기로
      </Link>
    </div>
  );
}
