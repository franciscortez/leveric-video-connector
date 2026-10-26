import { videoRoute, connectorPreflight } from "@/features/video-to-variations";
import { createEditResponse } from "@/features/video-to-variations";

/** Creates a new, empty edit. Body (optional): { name }. */
export async function POST(req: Request) {
  return videoRoute(req, () => createEditResponse(req));
}

export { connectorPreflight as OPTIONS };
