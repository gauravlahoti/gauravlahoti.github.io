"""Build Pulse's bundled map data from Natural Earth (public domain).

world.geojson   1:10m countries, India point-of-view variant, simplified for a
                560px world map. Properties: iso (ISO A2), name, cx/cy (a point
                inside the country, used when a page view has no coordinates).
india_states.geojson  state boundaries inside India, clipped to the India-POV
                outline so no disputed line is drawn, simplified for the inset.
"""
import json, sys
from shapely.geometry import shape, mapping
from shapely.ops import unary_union

out = sys.argv[1]
def r(geom, nd):
    """Round coordinates to keep the files small."""
    def rc(c):
        if isinstance(c[0], (int, float)):
            return [round(c[0], nd), round(c[1], nd)]
        return [rc(x) for x in c]
    g = mapping(geom); g = {"type": g["type"], "coordinates": rc(g["coordinates"])}
    return g

world = json.load(open("countries_ind.geojson"))
feats = []
india = None
for f in world["features"]:
    p = f["properties"]
    geom = shape(f["geometry"]).buffer(0)
    if p.get("ADM0_A3") == "IND":
        india = geom
    simp = geom.simplify(0.2, preserve_topology=True)
    if simp.is_empty or simp.area < 0.05:
        continue
    iso = p.get("ISO_A2_EH") if p.get("ISO_A2") in (None, "-99") else p.get("ISO_A2")
    pt = geom.representative_point()
    feats.append({"type": "Feature", "properties": {"iso": iso, "name": p.get("NAME"),
                  "cx": round(pt.x, 2), "cy": round(pt.y, 2)}, "geometry": r(simp, 1)})
json.dump({"type": "FeatureCollection", "features": feats}, open(f"{out}/world.geojson", "w"), separators=(",", ":"))

states = json.load(open("states.geojson"))
sf = []
for f in states["features"]:
    p = f["properties"]
    if p.get("adm0_a3") != "IND":
        continue
    g = shape(f["geometry"]).buffer(0).intersection(india)
    g = g.simplify(0.03, preserve_topology=True)
    if g.is_empty:
        continue
    sf.append({"type": "Feature", "properties": {"name": p.get("name")}, "geometry": r(g, 3)})
outline = india.simplify(0.02, preserve_topology=True)
sf.append({"type": "Feature", "properties": {"name": "__outline__"}, "geometry": r(outline, 3)})
json.dump({"type": "FeatureCollection", "features": sf}, open(f"{out}/india_states.geojson", "w"), separators=(",", ":"))
print(len(feats), "countries,", len(sf) - 1, "states")
