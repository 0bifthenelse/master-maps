import { clipLineStringToPolygon } from "../../../src/lib/geo/polygon";
const rect = (x0: number, y0: number, x1: number, y1: number): any => ({ type: "Polygon", coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]] });
for (const [x0, x1] of [[-10, 0], [0, 10], [10, 20], [20, 30]] as Array<[number, number]>) {
  const parts = clipLineStringToPolygon([[-5, 5], [25, 5]], rect(x0, 0, x1, 10));
  console.log(`baseline clip tile [${x0},${x1}] -> ${parts.length} part(s) ${JSON.stringify(parts)}`);
}
