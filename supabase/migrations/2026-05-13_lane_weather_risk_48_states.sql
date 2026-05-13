-- ============================================================================
-- Snapshot: refresh_lane_weather_risk (48-state observer)
-- ============================================================================
-- Date: 2026-05-13
-- Purpose: Version-controlled snapshot of the lane weather risk aggregator
--          after expansion from 15 WSF-only states to all 48 contiguous states.
--
-- Context: This function reads the most recent NOAA active-alerts response
--          from net._http_response (populated by fire_noaa_request via pg_cron
--          every 15 minutes), parses out alerts by state, scores them by
--          severity, and writes per-state rows into lane_weather_risk.
--
-- If this function is changed again, this file is the rollback target.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.refresh_lane_weather_risk()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
declare
  resp_record record;
  resp_body jsonb;
  features jsonb;
  feature jsonb;
  props jsonb;
  area_desc text;
  event_type text;
  event_severity numeric;
  wsf_states text[] := array[
    'AL','AR','AZ','CA','CO','CT','DE','FL','GA','IA',
    'ID','IL','IN','KS','KY','LA','MA','MD','ME','MI',
    'MN','MO','MS','MT','NC','ND','NE','NH','NJ','NM',
    'NV','NY','OH','OK','OR','PA','RI','SC','SD','TN',
    'TX','UT','VA','VT','WA','WI','WV','WY'
  ];
  st text;
  st_severity numeric;
  st_count integer;
  st_event text;
  st_events jsonb;
begin
  select * into resp_record
  from net._http_response
  where status_code = 200
    and content_type like '%geo+json%'
    and created > now() - interval '30 minutes'
  order by created desc
  limit 1;

  if resp_record is null or resp_record.content is null then
    raise notice 'No recent NOAA response found in net._http_response';
    return;
  end if;

  resp_body := resp_record.content::jsonb;
  features := resp_body -> 'features';

  foreach st in array wsf_states loop
    st_severity := 0;
    st_count := 0;
    st_event := null;
    st_events := '[]'::jsonb;

    if features is not null and jsonb_array_length(features) > 0 then
      for feature in select * from jsonb_array_elements(features) loop
        props := feature -> 'properties';
        area_desc := coalesce(props ->> 'areaDesc', '');
        if area_desc ilike '%, ' || st || '%' or area_desc ilike '%' || st || ';%' or area_desc ilike '% ' || st || '%' then
          event_type := coalesce(props ->> 'event', 'Unknown');
          event_severity := case
            when event_type ilike '%blizzard%' then 0.95
            when event_type ilike '%ice storm%' then 0.90
            when event_type ilike '%winter storm warning%' then 0.85
            when event_type ilike '%hurricane%' then 0.85
            when event_type ilike '%tornado warning%' then 0.80
            when event_type ilike '%severe thunderstorm warning%' then 0.65
            when event_type ilike '%winter weather%' then 0.55
            when event_type ilike '%flood warning%' then 0.55
            when event_type ilike '%winter storm watch%' then 0.45
            when event_type ilike '%freeze%' then 0.40
            when event_type ilike '%heat advisory%' then 0.35
            when event_type ilike '%wind advisory%' then 0.25
            when event_type ilike '%dense fog%' then 0.20
            else 0.15
          end;
          st_count := st_count + 1;
          if event_severity > st_severity then
            st_severity := event_severity;
            st_event := event_type;
          end if;
          st_events := st_events || jsonb_build_object('event', event_type, 'area', area_desc);
        end if;
      end loop;
    end if;

    insert into lane_weather_risk (state_code, severity, alert_count, highest_severity_event, raw_summary)
    values (st, st_severity, st_count, st_event, st_events);
  end loop;

  delete from lane_weather_risk where observed_at < now() - interval '7 days';
end;
$function$;
