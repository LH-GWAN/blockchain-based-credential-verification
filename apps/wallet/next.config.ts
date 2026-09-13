import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 워크스페이스 패키지(ESM dist)를 Next 번들러가 그대로 처리하도록 명시
  transpilePackages: ['@dbp/vc', '@dbp/rules'],
  // 지갑은 정적 자산 + 클라이언트 렌더링. 서버에는 개인정보가 절대 오지 않는다.
  poweredByHeader: false,
};

export default nextConfig;
