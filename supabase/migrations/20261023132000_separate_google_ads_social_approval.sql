-- Separate paid Google Ads proposals from Facebook/Instagram/X posts.
-- The current Performance Max adapter uses its own approved image assets.
CREATE OR REPLACE FUNCTION public.validate_google_ads_promotion(p_post_id bigint, p_days integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
    v_post record;
    v_existing_campaign record;

    v_daily_budget numeric := 0;
    v_monthly_budget numeric := 0;

    v_is_active boolean := false;
    v_auto_budget_enabled boolean := false;

    v_daily_spent numeric := 0;
    v_monthly_spent numeric := 0;

    v_daily_left numeric := 0;
    v_monthly_left numeric := 0;

    v_active_count integer := 0;
    v_projected_count integer := 1;

    v_daily_limit_share numeric := 0;
    v_monthly_limit_share numeric := 0;

    v_suggested_daily_budget numeric := 0;
    v_estimated_total_budget numeric := 0;
begin
    /*
     * Walidacja przygotowania NOWEJ kampanii Google Ads.
     *
     * Nie blokujemy kampanii PAUSED:
     * - PAUSED bez launched_at jest obsługiwane przez duplicate check
     *   w google-ads-create-campaign i może zostać ponownie użyte;
     * - PAUSED z launched_at oznacza zakończoną wcześniejszą promocję
     *   i nie blokuje przygotowania kolejnej kampanii.
     */

    if p_post_id is null or p_post_id <= 0 then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Nieprawidłowy identyfikator posta.'
        );
    end if;

    if p_days not in (3, 7) then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Czas promocji musi wynosić 3 albo 7 dni.'
        );
    end if;

    select
        id,
        platform,
        status,
        headline,
        content,
        image_url,
        city,
        country,
        promoted,
        promotion_status
    into v_post
    from public.marketing_queue
    where id = p_post_id;

    if not found then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Nie znaleziono wybranego posta.'
        );
    end if;

    -- Google Ads and social media are independent marketing workflows.
    -- Never treat a Facebook/Instagram/X publication as approval to spend on Google.
    if coalesce(v_post.platform,'') <> 'google_ads' then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Ta propozycja należy do mediów społecznościowych. Utwórz osobną reklamę w Google Ads.'
        );
    end if;

    if coalesce(v_post.status, '') <> 'approved' then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Najpierw zatwierdź szkic reklamy Google Ads w oddzielnym panelu.',
            'post_status', v_post.status
        );
    end if;

    if
        coalesce(v_post.promoted, false) = true
        and coalesce(v_post.promotion_status, '') = 'active'
    then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Ten post jest już oznaczony jako aktywnie promowany.'
        );
    end if;

    if coalesce(trim(v_post.content), '') = '' then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Post nie zawiera tekstu reklamy.'
        );
    end if;

    -- The existing PMax adapter attaches its own Google Ads image assets.
    -- A social-media post image is not a prerequisite for a Google Ads draft.
    /*
     * Blokujemy wyłącznie kampanię aktualnie tworzoną albo aktywną.
     * Kampanie PAUSED są rozstrzygane dokładniej w Edge Function.
     */
    select
        id,
        status,
        google_campaign_id
    into v_existing_campaign
    from public.google_ads_campaigns
    where marketing_queue_id = p_post_id
      and status in ('creating', 'draft', 'enabled')
    order by created_at desc
    limit 1;

    if found then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Dla tego posta istnieje już tworzona albo aktywna kampania Google Ads.',
            'existing_campaign_id', v_existing_campaign.id,
            'existing_status', v_existing_campaign.status,
            'google_campaign_id', v_existing_campaign.google_campaign_id
        );
    end if;

    select
        coalesce(daily_budget, 0),
        coalesce(monthly_budget, 0),
        coalesce(is_active, false),
        coalesce(auto_budget_enabled, false)
    into
        v_daily_budget,
        v_monthly_budget,
        v_is_active,
        v_auto_budget_enabled
    from public.marketing_settings
    where id = 1;

    if not found then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Nie znaleziono konfiguracji budżetu marketingowego.'
        );
    end if;

    if not v_is_active then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Marketing jest obecnie wyłączony.'
        );
    end if;

    if not v_auto_budget_enabled then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Automatyczne zarządzanie budżetem jest wyłączone.'
        );
    end if;

    if v_daily_budget <= 0 then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Dzienny budżet marketingowy musi być większy od zera.'
        );
    end if;

    if v_monthly_budget <= 0 then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Miesięczny budżet marketingowy musi być większy od zera.'
        );
    end if;

    select coalesce(sum(amount), 0)
    into v_daily_spent
    from public.marketing_spend
    where created_at >= date_trunc('day', now());

    select coalesce(sum(amount), 0)
    into v_monthly_spent
    from public.marketing_spend
    where created_at >= now() - interval '30 days';

    v_daily_left :=
        greatest(v_daily_budget - v_daily_spent, 0);

    v_monthly_left :=
        greatest(v_monthly_budget - v_monthly_spent, 0);

    select count(*)
    into v_active_count
    from public.active_promotions;

    v_projected_count := v_active_count + 1;

    v_daily_limit_share :=
        round(
            (
                v_daily_left
                / greatest(v_projected_count, 1)
            )::numeric,
            2
        );

    v_monthly_limit_share :=
        round(
            (
                v_monthly_left
                / p_days
            )::numeric,
            2
        );

    v_suggested_daily_budget :=
        greatest(
            least(
                v_daily_limit_share,
                v_monthly_limit_share
            ),
            0
        );

    v_estimated_total_budget :=
        round(
            (v_suggested_daily_budget * p_days)::numeric,
            2
        );

    if v_daily_left <= 0 then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Dzienny budżet marketingowy został wyczerpany.',
            'daily_left', v_daily_left
        );
    end if;

    if v_monthly_left <= 0 then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Miesięczny budżet marketingowy został wyczerpany.',
            'monthly_left', v_monthly_left
        );
    end if;

    if v_suggested_daily_budget <= 0 then
        return jsonb_build_object(
            'success', false,
            'can_start', false,
            'error', 'Brak dostępnego budżetu dla nowej kampanii.'
        );
    end if;

    return jsonb_build_object(
        'success', true,
        'can_start', true,

        'post', jsonb_build_object(
            'id', v_post.id,
            'headline', v_post.headline,
            'content', v_post.content,
            'image_url', v_post.image_url,
            'city', v_post.city,
            'country', v_post.country
        ),

        'promotion_days', p_days,

        'budget', jsonb_build_object(
            'daily_budget_limit', v_daily_budget,
            'daily_spent', v_daily_spent,
            'daily_left', v_daily_left,

            'monthly_budget_limit', v_monthly_budget,
            'monthly_spent', v_monthly_spent,
            'monthly_left', v_monthly_left,

            'active_promotions', v_active_count,
            'projected_active_promotions', v_projected_count,

            'daily_limit_share', v_daily_limit_share,
            'monthly_limit_share', v_monthly_limit_share,

            'suggested_daily_budget', v_suggested_daily_budget,
            'estimated_total_budget', v_estimated_total_budget
        )
    );
end;
$function$
