import osmtogeojson from 'osmtogeojson';

// Aframe component to load buildings from a geojson file or the Overpass API
//
// lat, lon: start position of the map at Aframe's origin (0,0)
// src: optional geojson asset to load on init (loads all buildings inside regardless of lat/lon/radius_m)
// radius_m: radius in meters around the start position to load buildings from Overpass API
//   default is 0 to disable loading from Overpass API, otherwise 500 is a good value
// zoom: zoom level, to load all buildings of a tile at once (doesn't influence map details)
//   smaller values load more buildings at once but may slow down rendering, higher values cause more requests
// trackId: optional id of a scene element for dynamic loading (usually the rig / user position)
//
// The component supports different use cases:
// * show buildings from a geojson file: set src to the asset url
// * show buildings around a given lat/lon: set lat, lon and radius_m
// * keep loading buildings around a moving element: set lat, lon and radius_m, set trackId to the element's id
// * show buildings of a geojson file and keep loading around a moving element: use all attributes
//
// OSM map tiles use the Web Mercator projection, assuming the earth is a sphere
// OSM features/buildings use the WGS84 ellipsoid (different circumference across equator and poles)
// While building data is not tiled like the map, we still use a tile system to load efficiently

AFRAME.registerComponent('osm-geojson', {
  schema: {
    lat: { type: 'number' },
    lon: { type: 'number' },
    src: { type: 'asset' },
    radius_m: { type: 'number', default: 0 },
    zoom: { type: 'number', default: 17 },
    trackId: { type: 'string' }
  },

  init: function () {
    this.EQUATOR_M = 40075017; // equatorial circumference in meters
    this.POLES_M = 40007863; // polar circumference in meters
    this.FEET_TO_METER = 0.3048;
    this.LEVEL_HEIGHT_M = 3; // default height in meters for a single building level
    this.DEFAULT_BUILDING_HEIGHT_M = 6; // default height in meters for buildings without height
    // some default values for buildings defined at https://wiki.openstreetmap.org/wiki/Key:building
    this.BUILDING_TO_METER = {
      church: 20,
      water_tower: 20,
      bungalow: this.LEVEL_HEIGHT_M,
      cabin: this.LEVEL_HEIGHT_M,
      ger: this.LEVEL_HEIGHT_M,
      houseboat: this.LEVEL_HEIGHT_M,
      static_caravan: this.LEVEL_HEIGHT_M,
      kiosk: this.LEVEL_HEIGHT_M,
      chapel: this.LEVEL_HEIGHT_M,
      shrine: this.LEVEL_HEIGHT_M,
      bakehouse: this.LEVEL_HEIGHT_M,
      toilets: this.LEVEL_HEIGHT_M,
      stable: this.LEVEL_HEIGHT_M,
      boathouse: this.LEVEL_HEIGHT_M,
      hut: this.LEVEL_HEIGHT_M,
      shed: this.LEVEL_HEIGHT_M,
      carport: this.LEVEL_HEIGHT_M,
      garage: this.LEVEL_HEIGHT_M,
      garages: this.LEVEL_HEIGHT_M,
      beach_hut: this.LEVEL_HEIGHT_M,
      container: this.LEVEL_HEIGHT_M,
      guardhouse: this.LEVEL_HEIGHT_M
    };

    this.tilesLoaded = new Set(); // contains each x,y tile id that has been loaded
    this.featuresLoaded = {}; // contains each feature id that has been added

    // for loading a geojson file from the src asset
    this.loader = new THREE.FileLoader();
    this.onSrcLoaded = this.onSrcLoaded.bind(this);
  },

  update: function (oldData) {
    if (this.data !== oldData) {
      this.trackElement = null;
      this.trackPosition = null;
      // reset the layer
      this.el.innerHTML = '';
      this.tilesLoaded.clear();
      this.featuresLoaded = {};

      this.tileSize_m = this.lat2tileWidth_m(this.data.lat, this.data.zoom);
      this.tileBase = this.latlon2fractionalTileId(this.data.lat, this.data.lon);

      if (this.data.src) {
        this.loader.load(this.data.src, this.onSrcLoaded);
      }

      this.loadTilesAround(new THREE.Vector3(0, 0, 0));

      // if trackId attribute is given, keep track of the element's position
      if (this.data.trackId) {
        const element = document.getElementById(this.data.trackId);
        if (element && element.object3D) {
          this.trackElement = element;
          this.trackPosition = new THREE.Vector3();
        }
      }
    }
  },

  tick: function () {
    if (this.trackElement) {
      // use world position to support movement of both head and rig
      this.trackElement.object3D.getWorldPosition(this.trackPosition);
      this.loadTilesAround(this.trackPosition);
    }
  },

  onSrcLoaded: function (text) {
    const json = JSON.parse(text);
    if (this.data.lat == 0 && this.data.lon == 0) {
      const center = this.features2center(json.features);
      this.data.lat = center[0];
      this.data.lon = center[1];
    }
    this.addBuildings(json);
  },

  // Convert latitude to width in meters for given zoom level
  lat2tileWidth_m: function (lat, zoom) {
    const nTiles = 2 ** zoom;
    const circumference_m = this.EQUATOR_M * Math.cos(lat * Math.PI / 180);
    return circumference_m / nTiles;
  },

  // Convert geocoordinates to tile coordinates for given zoom level
  // Returns floating point values where
  // * the integer part is the tile id
  // * the fractional part is the position within the tile
  latlon2fractionalTileId: function (lat, lon) {
    const nTiles = 2 ** this.data.zoom;
    const latRad = lat * Math.PI / 180;
    const x = nTiles * (lon + 180) / 360;
    const y = nTiles * (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
    return [x, y];
  },

  // Compute center of the given geojson features
  // we ignore point features and just take the first coordinate pair of each path
  // TODO: just use the bounding box center
  features2center: function (features) {
    let lat = 0;
    let lon = 0;
    let count = 0;
    for (const feature of features) {
      // just take the first coordinate pair of the outline, skip points
      const coords = feature.geometry.coordinates[0][0];
      if (coords && coords.length == 2) {
        lon += coords[0];
        lat += coords[1];
        count += 1;
      }
    }
    lat /= count;
    lon /= count;
    console.log('Geojson center (lat, lon): ', lat, lon);
    return [lat, lon];
  },

  // Load OSM building data for the bounding box
  // bboxArray is an array with [south,west,north,east] in degrees
  loadOSMbuildingsBbox: async function (bboxArray) {
    const bbox = bboxArray.join(',');
    // overpass query to get all buildings and building parts
    // adding skel to the last line may reduce the amount of data: out;>;out skel qt;
    const overpassQuery = `[out:json][timeout:30];(
        way["building"](${bbox});
        relation["building"]["type"="multipolygon"](${bbox});
        way["building:part"](${bbox});
        relation["building:part"]["type"="multipolygon"](${bbox});
        );out;>;out qt;
        `;

    const response = await fetch(
      'https://overpass-api.de/api/interpreter',
      {
        method: 'POST',
        body: 'data=' + encodeURIComponent(overpassQuery)
      }
    );
    if (response.ok) {
      const data = await response.json();
      console.log(data);
      return data;
    }
  },

  // Convert geocoordinates into meter-based positions around the given base
  // coordinates order in geojson is longitude, latitude!
  // coords is a path of [lon, lat] positions, e.g. [[13.41224,52.51712],[13.41150,52.51702],...]
  geojsonCoords2plane: function (coords, baseLat, baseLon) {
    const circumference_m = this.EQUATOR_M * Math.cos(baseLat * Math.PI / 180);
    return coords.map(([lon, lat]) => [
      (lon - baseLon) / 360 * circumference_m,
      (lat - baseLat) / 360 * this.POLES_M
    ]);
  },

  // Create the Aframe geometry by extruding building footprints to given height
  // xyCoords is an array of [x,y] positions in meters, e.g. [[0, 0], [1, 0], [1, 1], [0, 1]]
  // xyHoles is an optional array of paths to describe holes in the building footprint
  // height is the building height in meters from the base to the top, null to use a default
  // if minHeight is given, the geometry is moved up to reach from minHeight to the top
  createGeometry: function (xyCoords, xyHoles, height, minHeight) {
    const shape = new THREE.Shape(xyCoords.map(xy => new THREE.Vector2(xy[0], xy[1])));
    if (height === null) {
      // set the height based on the perimeter of the building if missing other info
      const perimeter_m = shape.getLength();
      height = Math.min(this.DEFAULT_BUILDING_HEIGHT_M, perimeter_m / 5);
    }
    for (const hole of xyHoles) {
      shape.holes.push(new THREE.Path(hole.map(xy => new THREE.Vector2(xy[0], xy[1]))));
    }
    height -= minHeight;
    const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });

    // ExtrudeGeometry expects x and y as base shape and extrudes z, rotate to match
    geometry.rotateX(-Math.PI / 2);
    if (minHeight) {
      geometry.translate(0, minHeight, 0);
    }
    return geometry;
  },

  // Generate a building from outline and height, both in meters
  // if minHeight is given, the building is extruded from that height upwards
  createBuilding: function (xyCoords, xyHoles, height, minHeight = 0) {
    // Create a mesh with the geometry and a material
    const geometry = this.createGeometry(xyCoords, xyHoles, height, minHeight);
    const material = new THREE.MeshBasicMaterial({ color: 0xaabbcc });
    const mesh = new THREE.Mesh(geometry, material);
    const entity = document.createElement('a-entity');
    entity.setObject3D('mesh', mesh);
    return entity;
  },

  // Convert a height string to meters, handling different units/formats
  height2meters: function (height) {
    if (height.indexOf("'") > 0) {
      // height given in feet and inches, convert to meter and ignore inches
      return parseFloat(height) * this.FEET_TO_METER;
    }
    // default unit is meters, parseFloat ignores any potentially appended " m"
    return parseFloat(height);
  },

  // Extract or estimate the height of a building
  // return null to set it later depending on the perimeter
  feature2height: function (feature) {
    // buildings can have a height defined with optional unit (default is meter)
    // https://wiki.openstreetmap.org/wiki/Key:height
    const properties = feature.properties;
    if ('height' in properties) {
      return this.height2meters(properties.height);
    }
    if ('building:levels' in properties) {
      return parseInt(properties['building:levels']) * this.LEVEL_HEIGHT_M;
    }
    if (properties.building in this.BUILDING_TO_METER) {
      return this.BUILDING_TO_METER[properties.building];
    }
    if (properties.man_made in this.BUILDING_TO_METER) {
      return this.BUILDING_TO_METER[properties.man_made];
    }
    return null;
  },

  // Building parts can define a minimum height, so they start at a higher position, e.g. a roof
  // Alternatively, building:min_level can be used
  // https://wiki.openstreetmap.org/wiki/Key:min_height
  feature2minHeight: function (feature) {
    const properties = feature.properties;
    if ('min_height' in properties) {
      return this.height2meters(properties.min_height);
    }
    if ('building:min_level' in properties) {
      return parseInt(properties['building:min_level']) * this.LEVEL_HEIGHT_M;
    }
    return 0;
  },

  // Extract or estimate building colour
  feature2color: function (feature) {
    const properties = feature.properties;
    if ('building:colour' in properties) {
      return properties['building:colour'];
    }
    return 'gray';
  },

  // Convert the geojson feature of a building into a 3d Aframe entity
  // baseLat and baseLon are used as reference position to convert geocoordinates to meters on plane
  feature2building: function (feature, baseLat, baseLon) {
    const paths = feature.geometry.coordinates;
    const xyOutline = this.geojsonCoords2plane(paths[0], baseLat, baseLon);
    const xyHoles = []; // Add holes to the building if more than one path given
    for (let i = 1; i < paths.length; i++) {
      xyHoles.push(this.geojsonCoords2plane(paths[i], baseLat, baseLon));
    }
    const height_m = this.feature2height(feature);
    if (height_m === 0) {
      return null; // skip building outlines that are covered by building parts
    }
    const minHeight_m = this.feature2minHeight(feature);
    const building = this.createBuilding(xyOutline, xyHoles, height_m, minHeight_m);

    const color = this.feature2color(feature);
    const material = `color: ${color}; opacity: 1.0;`;
    building.setAttribute('material', material);
    return building;
  },

  // Compute the bounding box of a tile at given zoom level in degrees
  tile2bbox: function (x, y, zoom) {
    const nTiles = 2 ** zoom;
    const north = 180 * Math.atan(Math.sinh(Math.PI * (1 - 2 * y / nTiles))) / Math.PI;
    const south = 180 * Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / nTiles))) / Math.PI;
    const west = x / nTiles * 360 - 180;
    const east = (x + 1) / nTiles * 360 - 180;
    return [south, west, north, east];
  },

  // Iterate over features in geojson and add buildings to the scene
  addBuildings: function (geojson) {
    let count = 0;
    let ignored = 0;
    let skipped = 0;
    const buildings = new Set();
    const parts = [];

    // iterate over all features and add buildings to the scene
    for (const feature of geojson.features) {
      const properties = feature.properties;
      if (('building' in properties || 'building:part' in properties) && !this.featuresLoaded[feature.id]) {
        this.featuresLoaded[feature.id] = true;
        const building = this.feature2building(feature, this.data.lat, this.data.lon);
        if (building) {
          this.el.appendChild(building);
          count += 1;
          if ('building' in properties) {
            buildings.add(building);
          } else {
            parts.push(building);
          }
        } else {
          skipped += 1;
        }
      } else {
        if (!this.featuresLoaded[feature.id] && feature.geometry.type != 'Point') {
          // console.log(feature);
        }
        ignored += 1;
      }
    }

    // remove buildings that are covered by building parts
    // Unfortunately, there's no enforced relation:
    // https://help.openstreetmap.org/questions/60330/how-do-you-create-a-relation-between-a-building-and-3d-building-parts
    // TODO: optimise logic and performance if needed
    const outer = new THREE.Box3();
    const inner = new THREE.Box3();
    for (const part of parts) {
      const uselessBuildings = new Set();
      inner.setFromObject(part.object3D);
      for (const building of buildings) {
        if (part.object3D.position.distanceTo(building.object3D.position) < 1) {
          outer.setFromObject(building.object3D);
          if (outer.containsBox(inner)) {
            uselessBuildings.add(building);
          }
        }
      }
      for (const building of uselessBuildings) {
        this.el.removeChild(building);
        buildings.delete(building);
        count -= 1;
        skipped += 1;
      }
    }
    console.log('Loaded', count, 'buildings, ignored', ignored, ', skipped', skipped);
  },

  // Check if all tiles within the default radius around the given position are fully loaded
  // otherwise load the missing ones as a single bounding box
  // pos is the position in meters on the Aframe plane, we ignore the height
  loadTilesAround: function (pos) {
    if (this.data.radius_m <= 0) {
      return;
    }
    const tileX = this.tileBase[0] + pos.x / this.tileSize_m;
    const tileY = this.tileBase[1] + pos.z / this.tileSize_m;

    const radius = this.data.radius_m / this.tileSize_m;
    const nTiles = 2 ** this.data.zoom;
    let startX = Math.floor(tileX - radius);
    const startY = Math.max(0, Math.floor(tileY - radius));
    let endX = Math.ceil(tileX + radius);
    const endY = Math.min(nTiles, Math.ceil(tileY + radius));
    // using modulo for horizontal axis to wrap around the date line
    startX = (startX + nTiles) % nTiles;
    endX = (endX + nTiles) % nTiles;
    // console.log(startX, startY, endX, endY);

    let bboxSWNE = []; // bounding box in [south,west,north,east] degrees
    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const xy = (y << this.data.zoom) + x;
        if (!this.tilesLoaded.has(xy)) {
          const bbox = this.tile2bbox(x, y, this.data.zoom);
          if (bboxSWNE.length == 0) {
            bboxSWNE = bbox;
          } else {
            bboxSWNE[0] = Math.min(bboxSWNE[0], bbox[0]);
            bboxSWNE[1] = Math.min(bboxSWNE[1], bbox[1]);
            bboxSWNE[2] = Math.max(bboxSWNE[2], bbox[2]);
            bboxSWNE[3] = Math.max(bboxSWNE[3], bbox[3]);
          }
          this.tilesLoaded.add(xy); // mark tile as loaded BEFORE the request to avoid multiple requests
        }
      }
    }

    if (bboxSWNE.length > 0) {
      console.log('Bounding box for missing tiles (SWNE): ', bboxSWNE);
      this.loadOSMbuildingsBbox(bboxSWNE).then((json) => {
        const geojson = osmtogeojson(json);
        this.addBuildings(geojson);
      });
    }
  }
});
