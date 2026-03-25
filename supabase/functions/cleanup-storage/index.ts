import { serve } from "https://deno.land/std/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js"

serve(async () => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  )

  const { data: vouchers } = await supabase
    .from("vouchers")
    .select("id,storage_path,booking_id")

  let deleted = 0

  for (const v of vouchers ?? []) {
    const { data: booking } = await supabase
      .from("bookings")
      .select("end_date")
      .eq("id", v.booking_id)
      .single()

    const shouldDelete =
      !booking ||
      (new Date(booking.end_date).getTime() + 180*24*60*60*1000 < Date.now())

    if (shouldDelete) {
      await supabase.storage
        .from("vouchers")
        .remove([v.storage_path])

      await supabase
        .from("vouchers")
        .delete()
        .eq("id", v.id)

      deleted++
    }
  }

  return new Response(`Storage cleanup done. Deleted ${deleted} vouchers.`)
})