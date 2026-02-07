import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-truenas-secret',
};

interface PendingUpload {
  id: string;
  project_id: string;
  file_name: string;
  storage_path: string;
  signed_url: string;
  signed_url_expires_at: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Authenticate using TrueNAS callback secret
    const truenasSecret = req.headers.get('x-truenas-secret');
    const expectedSecret = Deno.env.get('TRUENAS_CALLBACK_SECRET');

    if (!truenasSecret || truenasSecret !== expectedSecret) {
      console.error('Invalid or missing TrueNAS secret');
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Initialize service client for database operations
    const serviceClient = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    );

    // Get pending uploads that need deep analysis
    const { data: pendingUploads, error: fetchError } = await serviceClient
      .from('video_uploads')
      .select('id, project_id, file_name, storage_path, signed_url, signed_url_expires_at')
      .eq('deep_analysis_status', 'pending')
      .not('storage_path', 'is', null)
      .limit(5);

    if (fetchError) {
      console.error('Error fetching pending uploads:', fetchError);
      throw fetchError;
    }

    if (!pendingUploads || pendingUploads.length === 0) {
      return new Response(
        JSON.stringify({ success: true, uploads: [] }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Generate/refresh signed URLs for each upload
    const uploadsWithUrls: PendingUpload[] = [];
    const now = new Date();
    const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);

    for (const upload of pendingUploads) {
      // Check if existing signed URL is still valid (with 10 min buffer)
      const existingExpiry = upload.signed_url_expires_at 
        ? new Date(upload.signed_url_expires_at)
        : null;
      const bufferTime = new Date(now.getTime() + 10 * 60 * 1000);

      let signedUrl = upload.signed_url;
      let expiresAt = upload.signed_url_expires_at;

      if (!existingExpiry || existingExpiry < bufferTime) {
        // Generate new signed URL (valid for 1 hour)
        const { data: urlData, error: urlError } = await serviceClient.storage
          .from('video-uploads')
          .createSignedUrl(upload.storage_path, 3600);

        if (urlError) {
          console.error(`Error creating signed URL for ${upload.id}:`, urlError);
          continue;
        }

        signedUrl = urlData.signedUrl;
        expiresAt = oneHourFromNow.toISOString();

        // Update the record with new signed URL
        await serviceClient
          .from('video_uploads')
          .update({
            signed_url: signedUrl,
            signed_url_expires_at: expiresAt,
            deep_analysis_status: 'processing',
          })
          .eq('id', upload.id);
      } else {
        // Mark as processing
        await serviceClient
          .from('video_uploads')
          .update({ deep_analysis_status: 'processing' })
          .eq('id', upload.id);
      }

      uploadsWithUrls.push({
        id: upload.id,
        project_id: upload.project_id,
        file_name: upload.file_name,
        storage_path: upload.storage_path,
        signed_url: signedUrl!,
        signed_url_expires_at: expiresAt!,
      });
    }

    console.log(`Returning ${uploadsWithUrls.length} uploads for deep analysis`);

    return new Response(
      JSON.stringify({ success: true, uploads: uploadsWithUrls }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Deep analysis poll error:', error);
    return new Response(
      JSON.stringify({ success: false, error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
