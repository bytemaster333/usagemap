// SPDX-License-Identifier: Apache-2.0
// src/_data/scf.js — your site key (portal: site → Snippet), set at build time: SCF_SITE=… npx @11ty/eleventy
export default { site: process.env.SCF_SITE ?? "" };
