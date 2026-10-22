-- NOÉ schema (Aiven PostgreSQL + PostGIS). Re-runnable: drops everything first.
create extension if not exists postgis;

drop table if exists dove_calls, agent_log, insights, status_reports, missions, exposures, forecasts,
  rescuers, residents, sites, observations, observations_raw, stations,
  flows, flows_raw, rain, rain_raw, rain_stations, historic_floods, vigilance, flood_zones,
  disasters, communes, population_cells, addresses cascade;

create table stations (
  code text primary key, name text not null, river text,
  role text check (role in ('upstream','mid','target','downstream')),
  lat double precision not null, lon double precision not null,
  geom geography(point,4326) generated always as (st_setsrid(st_makepoint(lon,lat),4326)::geography) stored,
  threshold_m numeric, threshold_label text
);
create table observations_raw (station_code text, ts timestamptz, h_m numeric, source text, primary key(station_code, ts));
create table observations (station_code text references stations(code), ts timestamptz, h_m numeric, source text default 'hubeau', primary key(station_code, ts));
-- Hub'Eau discharge (m³/s), replayed like observations
create table flows_raw (station_code text, ts timestamptz, q_m3s numeric, source text, primary key(station_code, ts));
create table flows (station_code text references stations(code), ts timestamptz, q_m3s numeric, source text default 'hubeau', primary key(station_code, ts));

-- schools: Annuaire de l'éducation (capacity = pupils); care homes / hospitals: FINESS; campsites: OSM.
-- elevation_m: IGN RGE ALTI. official_zone / official_depth: Géorisques (filled by db:seed with PostGIS / WFS).
create table sites (
  id text primary key, kind text check (kind in ('care_home','school','campsite','hospital')),
  name text not null, capacity int, lat double precision not null, lon double precision not null,
  geom geography(point,4326) generated always as (st_setsrid(st_makepoint(lon,lat),4326)::geography) stored,
  elevation_m numeric, source text not null,
  category text, ref text, address text, phone text, capacity_source text,
  official_zone text check (official_zone in ('frequent','medium','extreme')), official_depth text
);
create table residents (
  id text primary key, name text not null, age int, language text default 'fr',
  mobility text check (mobility in ('ok','reduced','bedridden')), floor int default 0,
  address text, lat double precision not null, lon double precision not null,
  geom geography(point,4326) generated always as (st_setsrid(st_makepoint(lon,lat),4326)::geography) stored,
  elevation_m numeric, persona boolean default true,
  official_zone text check (official_zone in ('frequent','medium','extreme'))
);
create table rescuers (
  id text primary key, name text not null, org text, country text,
  tier text check (tier in ('T1','T2','T3')), available boolean default false,
  lat double precision, lon double precision, home_lat double precision, home_lon double precision,
  updated_at timestamptz default now(), persona boolean default true
);
create table forecasts (
  id bigserial primary key, created_at timestamptz default now(), sim_time timestamptz not null,
  station_code text references stations(code), h_now_m numeric, rate_cm_h numeric, eta_crossing timestamptz,
  peak_h_m numeric, peak_time timestamptz, confidence numeric, model text, threshold_m numeric
);
create table exposures (
  id bigserial primary key, forecast_id bigint references forecasts(id) on delete cascade,
  target_type text check (target_type in ('site','resident')), target_id text not null,
  eta timestamptz, depth_m numeric, priority int
);
create table missions (
  id bigserial primary key, created_at timestamptz default now(), rescuer_id text references rescuers(id),
  target_type text, target_id text, route_note text, required_tier text, insight_id bigint,
  status text default 'sent' check (status in ('sent','accepted','en_route','on_site','done','backup'))
);
create table status_reports (
  id bigserial primary key, resident_id text references residents(id),
  -- needs_help = urgent, unstable = OK for now but fragile, safe = not urgent (judged by the DOVE agent from the call)
  status text check (status in ('safe','unstable','needs_help')), can_climb_stairs boolean, notes text,
  channel text default 'voice', created_at timestamptz default now()
);
create table insights (
  id bigserial primary key, created_at timestamptz default now(), sim_time timestamptz,
  kind text, priority int, title text, detail text, confidence numeric,
  sources jsonb, action jsonb, status text default 'open', origin text default 'llm'
);
create table agent_log (id bigserial primary key, ts timestamptz default now(), sim_time timestamptz, agent text, message text, data jsonb);
create table dove_calls (
  id bigserial primary key, resident_id text references residents(id), created_at timestamptz default now(),
  state text default 'ringing' check (state in ('ringing','accepted','declined','ended','missed'))
);

-- ---- public reference data (scripts/fetch-official.ts, fetch-rain.ts, fetch-population.ts)
-- Vigicrues: highest floods on record per gauge
create table historic_floods (
  station_code text references stations(code), label text, h_m numeric, q_m3s numeric, source text default 'vigicrues',
  primary key (station_code, label)
);
-- Vigicrues vigilance per river section: snapshot at fetch time (Vigicrues publishes no archive)
create table vigilance (
  code text primary key, name text, level int, label text, fetched_at timestamptz, source text default 'vigicrues',
  geom geography(multilinestring,4326)
);
-- Météo-France hourly rain: rr1_mm = rain in the hour ending at ts. Replayed like observations.
create table rain_stations (
  code text primary key, name text not null, lat double precision not null, lon double precision not null, alt_m numeric,
  basin boolean, upstream boolean,
  geom geography(point,4326) generated always as (st_setsrid(st_makepoint(lon,lat),4326)::geography) stored
);
create table rain_raw (station_code text, ts timestamptz, rr1_mm numeric, primary key(station_code, ts));
create table rain (station_code text references rain_stations(code), ts timestamptz, rr1_mm numeric, primary key(station_code, ts));
-- Géorisques TRI flood-hazard polygons, river overflow (EU Floods Directive, 2020 reporting)
create table flood_zones (
  id text primary key, scenario text check (scenario in ('frequent','medium','extreme')), river text, tri text,
  source text default 'georisques', geom geography(multipolygon,4326) not null
);
-- geo.api.gouv.fr communes + Géorisques CatNat flood disaster declarations
create table communes (
  code text primary key, name text not null, population int, lat double precision, lon double precision,
  geom geography(point,4326) generated always as (st_setsrid(st_makepoint(lon,lat),4326)::geography) stored,
  flood_disasters int default 0, last_flood_disaster date, vidourle_atlas boolean, azi text[], tri text[]
);
create table disasters (
  code text, commune_code text references communes(code), start_date date, end_date date, published date, label text,
  source text default 'georisques', primary key (code, commune_code)
);
-- INSEE Filosofi 2019, 200 m grid (counts are INSEE estimates, hence numeric)
create table population_cells (
  id text primary key, ind numeric, men numeric, men_1ind numeric, ind_0_3 numeric, ind_65_79 numeric, ind_80p numeric,
  source text default 'insee', geom geography(polygon,4326) not null, centre geography(point,4326) not null
);
-- Base Adresse Nationale
create table addresses (
  id text primary key, label text, postcode text, insee text, commune text,
  lat double precision not null, lon double precision not null,
  geom geography(point,4326) generated always as (st_setsrid(st_makepoint(lon,lat),4326)::geography) stored
);

create index on observations (station_code, ts);
create index on observations_raw (ts);
create index on flows_raw (ts);
create index on rain_raw (ts);
create index on exposures (forecast_id);
create index on sites using gist (geom);
create index on residents using gist (geom);
create index on flood_zones using gist (geom);
create index on population_cells using gist (geom);
create index on addresses using gist (geom);

-- broadcast every write to the UI (payload must stay < 8 KB: no big blobs here)
create or replace function noe_notify() returns trigger as $$
begin
  perform pg_notify('noe_events', json_build_object('table', TG_TABLE_NAME, 'op', TG_OP,
    'row', (row_to_json(NEW)::jsonb - 'geom'))::text);
  return NEW;
end; $$ language plpgsql;

do $$ declare t text; begin
  foreach t in array array['observations','flows','rain','forecasts','exposures','missions','status_reports','insights','agent_log','rescuers','dove_calls'] loop
    execute format('create trigger %I_notify after insert or update on %I for each row execute function noe_notify()', t, t);
  end loop;
end $$;
