# Transitous Departures

A small Node.js service/container that displays the next five public-transport departures using the public Transitous API.

## Initial scope

- Query by latitude, longitude and radius.
- Select the nearest stop ID per broad mode category from the first API response.
- Fetch departures for selected stop IDs, sort by absolute timestamp, and show up to five.
- Format times in the local time zone supplied by Transitous as `place.tz` (IANA time-zone ID), independent of the container host time zone.
- No route planning, local timetable database, or Gladys integration yet.

This is a starter implementation, not yet a feature-complete port of the QNAP shell prototype. Urban/rural-specific stop selection and handling of all Transitous response variants still need validation against the prototype.

## Run with Node.js

Requires Node.js 22 or newer.

```sh
CONTACT="your-email-or-project-url" npm start
```

Open `http://localhost:8080`.

## Run with Podman or Docker

```sh
podman build -t transitous-departures:0.1.0 .
podman run --rm -p 8080:8080 \
  -e CONTACT="your-email-or-project-url" \
  transitous-departures:0.1.0
```

Open `http://localhost:8080`.

## Endpoints

- `GET /health`
- `GET /api/departures?lat=49.411223&lon=8.711499&radius=200`

## Transitous

Check the current API usage policy before deploying or publishing. The project should use a descriptive User-Agent/contact, respect service limits, and provide visible attribution.

- https://transitous.org/api/
- https://transitous.org/sources/

## Initial limitations

- Stop selection is based on modes present in the first API response; stops without departures in that response may be missed.
- Rural/urban search strategy is not implemented yet.
- The API may represent one physical stop with several stop IDs.
- No caching layer yet.
- The browser interface is intentionally minimal.
