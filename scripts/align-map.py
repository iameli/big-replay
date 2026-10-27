#!/usr/bin/env python3
"""Fit screenshot pixels to map pixels; export an aligned PNG, overlay, and fit report.

Requires Pillow. Landmarks CSV: label,screenshot_x,screenshot_y,map_x,map_y.
Coordinates are original-image pixels, measured right/down from the top-left.
"""
import argparse
import csv
import json
import math
from pathlib import Path
import warnings

from PIL import Image, ImageDraw


def read_landmarks(path, source_size, reference_size):
    points = []
    fields = ("screenshot_x", "screenshot_y", "map_x", "map_y")
    with path.open(newline="", encoding="utf-8-sig") as stream:
        reader = csv.DictReader(stream)
        if not {"label", *fields}.issubset(reader.fieldnames or []):
            raise ValueError("CSV needs label,screenshot_x,screenshot_y,map_x,map_y headers")
        for row_number, row in enumerate(reader, 2):
            try:
                values = [float(row[key]) for key in fields]
            except (TypeError, ValueError) as error:
                raise ValueError(f"CSV row {row_number}: coordinates must be numbers") from error
            limits = (*source_size, *reference_size)
            if not all(math.isfinite(v) and 0 <= v < limit
                       for v, limit in zip(values, limits)):
                raise ValueError(f"CSV row {row_number}: coordinates must lie inside the original images")
            points.append({"label": row["label"], "source": values[:2], "map": values[2:]})
    if len(points) < 3:
        raise ValueError("Supply at least three landmark pairs; 6-12 spread-out pairs are preferable")
    return points


def project(matrix, point):
    a, b, tx, c, d, ty = matrix
    x, y = point
    return [a * x + b * y + tx, c * x + d * y + ty]


def fit_similarity(points):
    """Least-squares rotation + positive uniform scale + translation; no reflection."""
    count = len(points)
    sx, sy = [math.fsum(p["source"][axis] for p in points) / count for axis in (0, 1)]
    mx, my = [math.fsum(p["map"][axis] for p in points) / count for axis in (0, 1)]
    centered = [(p["source"][0] - sx, p["source"][1] - sy,
                 p["map"][0] - mx, p["map"][1] - my) for p in points]
    denominator = math.fsum(x * x + y * y for x, y, _, _ in centered)
    if denominator <= 1e-12:
        raise ValueError("Screenshot landmarks must occupy different positions")
    a = math.fsum(x * u + y * v for x, y, u, v in centered) / denominator
    b = math.fsum(x * v - y * u for x, y, u, v in centered) / denominator
    if math.hypot(a, b) <= 1e-12:
        raise ValueError("Landmarks do not determine a nonzero scale; check pairings")
    matrix = [a, -b, mx - a * sx + b * sy, b, a, my - b * sx - a * sy]
    residuals = []
    for index, point in enumerate(points, 1):
        predicted = project(matrix, point["source"])
        error = [predicted[axis] - point["map"][axis] for axis in (0, 1)]
        residuals.append({"index": index, **point, "predicted_map": predicted,
                          "error_xy": error, "error_pixels": math.hypot(*error)})
    return matrix, residuals


def inverse(matrix):
    a, b, tx, c, d, ty = matrix
    determinant = a * d - b * c
    return [d / determinant, -b / determinant, (b * ty - d * tx) / determinant,
            -c / determinant, a / determinant, (c * tx - a * ty) / determinant]


def framing(matrix, source_size, reference_size, width, mode):
    sw, sh = source_size
    rw, rh = reference_size
    corners = [project(matrix, p) for p in ((0, 0), (sw, 0), (sw, sh), (0, sh))]
    left = math.floor(min(0, *(p[0] for p in corners))) if mode == "full" else 0
    right = math.ceil(max(rw, *(p[0] for p in corners))) if mode == "full" else rw
    top = math.floor(min(0, *(p[1] for p in corners)))
    bottom = math.ceil(max(rh, *(p[1] for p in corners)))
    scale = width / (right - left)
    height = math.ceil((bottom - top) * scale)
    a, b, tx, c, d, ty = matrix
    output_matrix = [scale * a, scale * b, scale * (tx - left),
                     scale * c, scale * d, scale * (ty - top)]
    return output_matrix, (width, height), {
        "mode": mode, "bounds_in_map_pixels": [left, top, right, bottom],
        "map_to_output": [scale, 0, -left * scale, 0, scale, -top * scale],
        "source_corners_in_map_pixels": corners,
        "horizontal_source_clipped": any(p[0] < left or p[0] > right for p in corners),
    }


def warp(source, size, matrix):
    # Sampling the source directly avoids an intermediate rotation/resizing pass.
    # Pillow preserves RGB here; validity outside the source is a separate mask.
    result = source.transform(size, Image.Transform.AFFINE, inverse(matrix),
                              resample=Image.Resampling.BICUBIC)
    with Image.new("L", source.size, 255) as coverage:
        alpha = coverage.transform(size, Image.Transform.AFFINE, inverse(matrix),
                                   resample=Image.Resampling.BILINEAR)
    if source.mode == "RGBA":
        # Its transformed alpha already includes both original transparency and bounds.
        alpha.close()
    else:
        result.putalpha(alpha)
        alpha.close()
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("screenshot", type=Path)
    parser.add_argument("landmarks", type=Path)
    parser.add_argument("--reference", type=Path, default=Path(__file__).resolve().parent.parent / "bigmap.jpeg")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--width", type=int, default=4096)
    parser.add_argument("--framing", choices=("full", "map"), default="full",
                        help="full: fit screenshot + reference; map: crop to reference's horizontal extent")
    args = parser.parse_args()
    if args.width <= 0:
        parser.error("--width must be positive")
    try:
        # The known 15360x8640 local screenshot exceeds Pillow's warning threshold,
        # but remains below its hard decompression-bomb limit. Keep that limit intact.
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            source = Image.open(args.screenshot)
        with source, Image.open(args.reference) as reference:
            if source.mode not in ("RGB", "RGBA"):
                raise ValueError("Screenshot must be RGB or RGBA")
            points = read_landmarks(args.landmarks, source.size, reference.size)
            matrix, residuals = fit_similarity(points)
            output_matrix, size, frame = framing(matrix, source.size, reference.size, args.width, args.framing)
            # Do not overwrite inputs, even if they are named like generated outputs.
            names = ("aligned.png", "overlap.png", "alignment.json")
            inputs = {p.resolve() for p in (args.screenshot, args.landmarks, args.reference)}
            if any((args.output_dir / name).resolve() in inputs for name in names):
                raise ValueError("Output directory would overwrite an input file")
            args.output_dir.mkdir(parents=True, exist_ok=True)
            with warp(source, size, output_matrix) as aligned:
                aligned.save(args.output_dir / "aligned.png")
            with warp(source, reference.size, matrix) as mapped, reference.convert("RGBA") as base:
                # Half-opacity screenshot over the original, in ORIGINAL map pixels.
                with mapped.getchannel("A") as alpha:
                    mapped.putalpha(alpha.point(lambda value: value // 2))
                overlay = Image.alpha_composite(base, mapped)
            with overlay:
                draw = ImageDraw.Draw(overlay)
                for point in residuals:
                    u, v = point["map"]
                    px, py = point["predicted_map"]
                    draw.line((u, v, px, py), fill="yellow", width=2)
                    draw.ellipse((u - 5, v - 5, u + 5, v + 5), outline="cyan", width=2)
                    draw.ellipse((px - 3, py - 3, px + 3, py + 3), outline="magenta", width=2)
                    draw.text((u + 8, v + 8), str(point["index"]), fill="white", stroke_width=2, stroke_fill="black")
                overlay.save(args.output_dir / "overlap.png")
            errors = [p["error_pixels"] for p in residuals]
            report = {
                "model": "least-squares similarity (no reflection, shear, or perspective)",
                "coordinate_convention": "original pixels; origin top-left; x right, y down",
                "matrix_convention": "[a,b,tx,c,d,ty]: u=a*x+b*y+tx; v=c*x+d*y+ty",
                "screenshot": str(args.screenshot.resolve()), "source_size": source.size,
                "reference": str(args.reference.resolve()), "reference_size": reference.size,
                "source_to_map": matrix, "source_to_output": output_matrix,
                "scale_map_pixels_per_source_pixel": math.hypot(matrix[0], matrix[3]),
                "rotation_clockwise_degrees": math.degrees(math.atan2(matrix[3], matrix[0])),
                "rms_error_map_pixels": math.sqrt(math.fsum(e * e for e in errors) / len(errors)),
                "max_error_map_pixels": max(errors), "output_size": size,
                "framing": frame, "landmarks": residuals,
            }
            (args.output_dir / "alignment.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
            print(f"Scale: {report['scale_map_pixels_per_source_pixel']:.9f}; clockwise rotation: {report['rotation_clockwise_degrees']:.6f} deg")
            print(f"Residuals in original map pixels: RMS {report['rms_error_map_pixels']:.3f}; max {max(errors):.3f}")
            for point in residuals:
                print(f"  {point['index']:2d}. {point['label']}: {point['error_pixels']:.3f} px")
            print(f"Output: {size[0]} x {size[1]} -> {args.output_dir / 'aligned.png'}")
            if frame["horizontal_source_clipped"]:
                print("Map framing clips the screenshot horizontally; use --framing full to retain it.")
            print("Inspect overlap.png before accepting the fit; no outliers were discarded.")
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        parser.exit(1, f"Alignment failed: {error}\n")


if __name__ == "__main__":
    main()
