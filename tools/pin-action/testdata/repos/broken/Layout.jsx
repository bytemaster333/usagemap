import Script from "next/script";

export default function Layout({ children }) {
  return (
    <>
      <Script src={"https://e1.usagemap.dev/lib/1.0.0/strict.js"} data-site="wahlKtTDJ3zAB8bTItq9Cm" strategy="afterInteractive" />
      {children}
    </>
  );
}
