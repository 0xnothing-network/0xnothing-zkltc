import { SkeletonRows } from "@fi/components/UiStates";

export default function Loading() {
  return <div className="fi-route-loading"><div><SkeletonRows count={5} label="Loading 0xFi" /></div></div>;
}
