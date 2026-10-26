import { videoRoute, connectorPreflight } from "@/features/video-to-variations";
import { healthResponse } from "@/features/video-to-variations";

export async function GET(req?: Request) {
  return videoRoute(req, () => healthResponse());
}

export { connectorPreflight as OPTIONS };
