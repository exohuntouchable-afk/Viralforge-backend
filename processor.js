require('dotenv').config();
const AssemblyAI = require('assemblyai').AssemblyAI;
const OpenAI = require('openai');
const cloudinary = require('cloudinary').v2;
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const fs = require('fs');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegPath);

const assemblyClient = new AssemblyAI({ apiKey: process.env.ASSEMBLYAI_API_KEY });
const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// STEP 1: Upload video to Cloudinary
async function uploadToCloudinary(videoPath, videoName) {
  console.log('Uploading video to Cloudinary...');
  const result = await cloudinary.uploader.upload(videoPath, {
    resource_type: 'video',
    public_id: `viralforge/raw/${Date.now()}_${videoName}`,
    overwrite: true
  });
  return result.secure_url;
}

// STEP 2: Transcribe with AssemblyAI and detect best moments
async function transcribeAndAnalyze(videoUrl) {
  console.log('Transcribing video with AssemblyAI...');
  
  const transcript = await assemblyClient.transcripts.transcribe({
    audio_url: videoUrl,
    auto_highlights: true,
    sentiment_analysis: true,
    iab_categories: true,
    speaker_labels: true
  });

  // Extract best moments based on highlights and sentiment
  const highlights = transcript.auto_highlights_result?.results || [];
  const sentences = transcript.sentiment_analysis_results || [];
  
  // Score each sentence for virality
  const scoredMoments = sentences.map(sentence => ({
    text: sentence.text,
    start: sentence.start,
    end: sentence.end,
    score: calculateViralityScore(sentence, highlights)
  }));

  // Sort by score and pick top moments
  const topMoments = scoredMoments
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    fullTranscript: transcript.text,
    topMoments,
    highlights
  };
}

// Score moments for virality potential
function calculateViralityScore(sentence, highlights) {
  let score = 0;
  
  // Positive sentiment gets higher score
  if (sentence.sentiment === 'POSITIVE') score += 3;
  if (sentence.sentiment === 'NEGATIVE') score += 1;
  
  // Check if sentence contains highlighted keywords
  highlights.forEach(highlight => {
    if (sentence.text.toLowerCase().includes(highlight.text.toLowerCase())) {
      score += highlight.count * 2;
    }
  });

  // Longer sentences with more content score higher
  const wordCount = sentence.text.split(' ').length;
  if (wordCount > 10 && wordCount < 40) score += 2;

  return score;
}

// STEP 3: Cut video clips using FFmpeg
async function cutVideoClips(videoPath, topMoments) {
  console.log('Cutting video clips with FFmpeg...');
  const clips = [];
  
  for (let i = 0; i < Math.min(topMoments.length, 3); i++) {
    const moment = topMoments[i];
    const startSec = moment.start / 1000;
    const endSec = moment.end / 1000;
    const duration = Math.min(endSec - startSec + 2, 60); // Max 60 seconds
    const outputPath = `uploads/clip_${i}_${Date.now()}.mp4`;

    await new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .setStartTime(Math.max(0, startSec - 1))
        .setDuration(duration)
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    clips.push({ path: outputPath, moment, index: i });
  }

  return clips;
}

// STEP 4: Resize clips for each platform
async function resizeForPlatforms(clips) {
  console.log('Resizing clips for each platform...');
  const platformClips = [];

  const platforms = [
    { name: 'tiktok', width: 1080, height: 1920, aspect: '9:16' },
    { name: 'instagram_reels', width: 1080, height: 1920, aspect: '9:16' },
    { name: 'youtube_shorts', width: 1080, height: 1920, aspect: '9:16' },
    { name: 'instagram_feed', width: 1080, height: 1080, aspect: '1:1' },
    { name: 'linkedin', width: 1920, height: 1080, aspect: '16:9' }
  ];

  for (const clip of clips) {
    for (const platform of platforms) {
      const outputPath = `uploads/${platform.name}_clip_${clip.index}_${Date.now()}.mp4`;

      await new Promise((resolve, reject) => {
        ffmpeg(clip.path)
          .videoFilters([
            `scale=${platform.width}:${platform.height}:force_original_aspect_ratio=decrease`,
            `pad=${platform.width}:${platform.height}:(ow-iw)/2:(oh-ih)/2:black`
          ])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // Upload resized clip to Cloudinary
      const uploaded = await cloudinary.uploader.upload(outputPath, {
        resource_type: 'video',
        public_id: `viralforge/clips/${platform.name}_${clip.index}_${Date.now()}`,
        overwrite: true
      });

      platformClips.push({
        platform: platform.name,
        clipIndex: clip.index,
        url: uploaded.secure_url,
        moment: clip.moment
      });

      // Clean up local file
      fs.unlinkSync(outputPath);
    }
    // Clean up original clip
    fs.unlinkSync(clip.path);
  }

  return platformClips;
}

// STEP 5: Generate captions with OpenAI using Brand DNA
async function generateCaptions({ transcript, brand_dna, goal, niche, context, platforms }) {
  console.log('Generating captions with OpenAI...');
  
  const captions = {};

  const platformInstructions = {
    tiktok: 'Write a TikTok caption. Max 150 characters. Punchy, casual, use 1-2 emojis, add a hook.',
    instagram: 'Write an Instagram caption. 150-300 characters. Engaging, storytelling tone, 5-10 relevant hashtags.',
    youtube: 'Write a YouTube Shorts description. 100-200 characters. Clear value proposition, call to action.',
    twitter: 'Write a Tweet. Max 280 characters. Punchy, opinionated, no hashtags unless critical.',
    linkedin: 'Write a LinkedIn post. Professional but personal. 200-400 characters. End with a question or insight.'
  };

  for (const platform of platforms) {
    const response = await openaiClient.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: `You are a social media expert who writes content in the exact voice and style of the creator. 
          
Brand DNA: ${brand_dna || 'Authentic, engaging content creator'}
Goal: ${goal || 'Grow following'}
Niche: ${niche || 'General content'}

IMPORTANT: Write exactly in the creator's voice based on their Brand DNA. Do not sound generic.`
        },
        {
          role: 'user',
          content: `Video transcript: "${transcript}"
          
Additional context: ${context || 'No additional context'}

${platformInstructions[platform] || platformInstructions.instagram}

Write only the caption, nothing else.`
        }
      ],
      max_tokens: 300
    });

    captions[platform] = response.choices[0].message.content.trim();
  }

  return captions;
}

// STEP 6: Generate hashtags with OpenAI
async function generateHashtags({ niche, transcript, platform }) {
  const response = await openaiClient.chat.completions.create({
    model: 'gpt-4',
    messages: [
      {
        role: 'user',
        content: `Generate 15 trending hashtags for a ${platform} post about: "${transcript.substring(0, 200)}"
Niche: ${niche}
Return only hashtags separated by spaces, no explanation.`
      }
    ],
    max_tokens: 100
  });

  return response.choices[0].message.content.trim();
}

// MAIN PROCESS FUNCTION
async function processVideo({ videoPath, videoName, brand_dna, goal, niche, context }) {
  try {
    // Step 1: Upload raw video
    const videoUrl = await uploadToCloudinary(videoPath, videoName);
    
    // Step 2: Transcribe and find best moments
    const { fullTranscript, topMoments } = await transcribeAndAnalyze(videoUrl);
    
    // Step 3: Cut clips
    const clips = await cutVideoClips(videoPath, topMoments);
    
    // Step 4: Resize for platforms
    const platformClips = await resizeForPlatforms(clips);
    
    // Step 5: Generate captions
    const captions = await generateCaptions({
      transcript: fullTranscript,
      brand_dna,
      goal,
      niche,
      context,
      platforms: ['tiktok', 'instagram', 'youtube', 'twitter', 'linkedin']
    });

    // Step 6: Generate hashtags
    const hashtags = {};
    for (const platform of ['tiktok', 'instagram', 'youtube']) {
      hashtags[platform] = await generateHashtags({
        niche,
        transcript: fullTranscript,
        platform
      });
    }

    // Clean up original upload
    fs.unlinkSync(videoPath);

    return {
      transcript: fullTranscript,
      topMoments,
      platformClips,
      captions,
      hashtags
    };

  } catch (error) {
    console.error('processVideo error:', error);
    throw error;
  }
}

module.exports = { processVideo, generateCaptions };
