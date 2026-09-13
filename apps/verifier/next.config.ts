import type { NextConfig } from "next";

// 검증기관 화면은 검증 서비스(NEXT_PUBLIC_VERIFIER_URL) 하나만 호출한다.
// 발급기관 URL 은 이 앱 어디에도 존재하지 않는다 (프롬프트 §2-5).
const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
