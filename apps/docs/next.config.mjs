// SPDX-License-Identifier: Apache-2.0
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** Served at https://docs.usagemap.dev as a static export. */
/** @type {import('next').NextConfig} */
const config = {
  output: "export",
  trailingSlash: true,
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default withMDX(config);
