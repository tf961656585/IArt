"use client";

import { createElement, memo, type ImgHTMLAttributes } from "react";

export const RawImage = memo(function RawImage(props: ImgHTMLAttributes<HTMLImageElement>) {
  return createElement("img", props);
});

export default RawImage;
