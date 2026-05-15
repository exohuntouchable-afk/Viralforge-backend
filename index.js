require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { processVideo } = require('./processor');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ViralForge backend is running' });
});

// Main video processing endpoint
app.post('/process-video', upload.single('video'), async (req, res) => {
  try {
    const { brand_dna, goal, niche, context } = req.body;
    const videoFile = req.file;

    if (!videoFile) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    console.log('Processing video:', videoFile.originalname);

    const result = await processVideo({
      videoPath: videoFile.path,
      videoName: videoFile.originalname,
      brand_dna,
      goal,
      niche,
      context
    });

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Processing error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate captions only endpoint
app.post('/generate-captions', async (req, res) => {
  try {
    const { transcript, brand_dna, goal, niche, context, platforms } = req.body;
    const { generateCaptions } = require('./processor');

    const captions = await generateCaptions({
      transcript,
      brand_dna,
      goal,
      niche,
      context,
      platforms: platforms || ['tiktok', 'instagram', 'youtube', 'twitter', 'linkedin']
    });

    res.json({ success: true, captions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ViralForge backend running on port ${PORT}`);
});
