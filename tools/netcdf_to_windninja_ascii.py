#!/usr/bin/env python3
"""Convert Wind3D assimilation/native NetCDF output to WindNinja ASCII grids.

The MaomaoEarth wind layer reads WindNinja ASCII (vel/ang/prj).  The station
assimilation and native assimilation modes primarily write NetCDF; this helper
projects their U_wind/V_wind fields onto the same display layout so all four
Wind3D modes can be shown in the 3D map.
"""
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path

import netCDF4
import numpy as np


def _wkt(dataset: netCDF4.Dataset) -> str | None:
    if "crs" in dataset.variables:
        crs = dataset.variables["crs"]
        for name in ("crs_wkt", "spatial_ref"):
            value = getattr(crs, name, None)
            if value:
                return str(value)
    for name in ("crs_wkt", "spatial_ref"):
        value = getattr(dataset, name, None)
        if value:
            return str(value)
    return None


def _timestamp(dataset: netCDF4.Dataset, path: Path) -> str:
    raw = str(getattr(dataset, "target_time_utc", "") or "")
    match = re.search(r"(\d{4})-?(\d{2})-?(\d{2})[T_ ]?(\d{2}):?(\d{2}):?(\d{2})", raw)
    if not match:
        match = re.search(r"(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z", path.name)
    if not match:
        return "00000000T000000Z"
    year, month, day, hour, minute, second = match.groups()
    return f"{year}{month}{day}T{hour}{minute}{second}Z"


def _write_ascii(path: Path, values: np.ndarray, xll: float, yll: float, cellsize: float) -> None:
    nrows, ncols = values.shape
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(f"ncols {ncols}\n")
        handle.write(f"nrows {nrows}\n")
        handle.write(f"xllcorner {xll:.6f}\n")
        handle.write(f"yllcorner {yll:.6f}\n")
        handle.write(f"cellsize {cellsize:.6f}\n")
        handle.write("NODATA_value -9999\n")
        for row in values:
            handle.write(" ".join(f"{float(value):.4f}" for value in row) + "\n")


def convert_one(path: Path, output_root: Path, fallback_resolution: int) -> dict:
    with netCDF4.Dataset(path) as dataset:
        if "U_wind" not in dataset.variables or "V_wind" not in dataset.variables:
            return {"file": str(path), "skipped": "U_wind/V_wind missing"}
        if "x" not in dataset.variables or "y" not in dataset.variables:
            return {"file": str(path), "skipped": "x/y missing"}
        x = np.asarray(dataset.variables["x"][:], dtype=np.float64).ravel()
        y = np.asarray(dataset.variables["y"][:], dtype=np.float64).ravel()
        u = np.ma.filled(dataset.variables["U_wind"][:], np.nan).astype(np.float64)
        v = np.ma.filled(dataset.variables["V_wind"][:], np.nan).astype(np.float64)
        if u.ndim == 2:
            u = u[None, :, :]
            v = v[None, :, :]
        if u.ndim != 3 or u.shape[1:] != (y.size, x.size):
            return {"file": str(path), "skipped": f"unexpected shape {u.shape}"}
        if x.size < 2 or y.size < 2:
            return {"file": str(path), "skipped": "grid too small"}

        dx = float(np.median(np.abs(np.diff(x))))
        dy = float(np.median(np.abs(np.diff(y))))
        if not math.isfinite(dx) or not math.isfinite(dy) or dx <= 0 or dy <= 0:
            return {"file": str(path), "skipped": "invalid grid spacing"}
        if y[1] > y[0]:
            y = y[::-1]
            u = u[:, ::-1, :]
            v = v[:, ::-1, :]
        # x/y in Wind3D NetCDF are cell centres; ESRI ASCII wants the corner.
        xll = float(x[0] - dx / 2.0)
        yll = float(y[-1] - dy / 2.0)
        cellsize = dx

        heights = dataset.variables.get("height")
        height_values = (
            np.asarray(heights[:], dtype=np.float64).ravel()
            if heights is not None
            else np.asarray([float(getattr(dataset, "output_height_m", 50.0))])
        )
        resolution = int(getattr(dataset, "mesh_resolution_m", fallback_resolution) or fallback_resolution)
        timestamp = _timestamp(dataset, path)
        wkt = _wkt(dataset)
        if not wkt:
            return {"file": str(path), "skipped": "CRS WKT missing"}

        written = []
        for index in range(u.shape[0]):
            height = float(height_values[index] if index < height_values.size else height_values[-1])
            speed = np.hypot(u[index], v[index])
            direction = (np.degrees(np.arctan2(-u[index], -v[index])) + 360.0) % 360.0
            invalid = ~np.isfinite(speed) | ~np.isfinite(direction)
            speed = np.where(invalid, -9999.0, speed)
            direction = np.where(invalid, -9999.0, direction)
            target = (
                output_root
                / timestamp
                / f"h{int(round(height)):03d}m"
                / f"r{resolution:04d}m"
            )
            stem = path.stem
            _write_ascii(target / f"{stem}_vel.asc", speed, xll, yll, cellsize)
            _write_ascii(target / f"{stem}_ang.asc", direction, xll, yll, cellsize)
            (target / f"{stem}_vel.prj").write_text(wkt, encoding="utf-8")
            written.append(str(target / f"{stem}_vel.asc"))
        return {"file": str(path), "written": written}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--nc-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--resolution", type=int, default=200)
    args = parser.parse_args()

    results = []
    for path in sorted(args.nc_dir.glob("*.nc")):
        try:
            results.append(convert_one(path, args.output_dir, args.resolution))
        except Exception as exc:  # keep the rest of the batch inspectable
            results.append({"file": str(path), "error": f"{type(exc).__name__}: {exc}"})
    print(json.dumps({"ok": True, "results": results}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
