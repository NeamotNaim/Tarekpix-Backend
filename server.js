require('dotenv').config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");
const jwt = require("jsonwebtoken");

// Initialize Application Insights if key is provided
if (process.env.APPINSIGHTS_INSTRUMENTATIONKEY && process.env.APPINSIGHTS_INSTRUMENTATIONKEY !== 'your_appinsights_key') {
    const appInsights = require("applicationinsights");
    appInsights.setup(process.env.APPINSIGHTS_INSTRUMENTATIONKEY).start();
}

const app = express();
app.use(cors());
app.use(express.json());

// Set up Azure Storage
const storageConnectionString = process.env.STORAGE_CONNECTION_STRING;
let containerClient = null;

if (storageConnectionString && !storageConnectionString.includes('your_key')) {
    const blobServiceClient = BlobServiceClient.fromConnectionString(storageConnectionString);
    containerClient = blobServiceClient.getContainerClient("images");
    // Ensure container exists
    containerClient.createIfNotExists({ access: 'blob' }).catch(console.error);
}

// Set up Azure Cosmos DB
const cosmosConnectionString = process.env.COSMOS_CONNECTION_STRING;
let cosmosContainer = null;

if (cosmosConnectionString && !cosmosConnectionString.includes('your_key')) {
    const client = new CosmosClient(cosmosConnectionString);
    const database = client.database("TarekPixDB");
    cosmosContainer = database.container("Images");

    // Create DB and container if they don't exist
    client.databases.createIfNotExists({ id: "TarekPixDB" })
        .then(() => database.containers.createIfNotExists({ id: "Images", partitionKey: "/id" }))
        .catch(console.error);
}

// Fallback logic for local testing without Azure config
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
app.use("/uploads", express.static(uploadDir));
let localImages = [];

// Multer memory storage for Azure upload
const upload = multer({ storage: multer.memoryStorage() });

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "Access denied. No token provided." });
    }
    const token = authHeader.split(" ")[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        res.status(400).json({ error: "Invalid token." });
    }
};

// Login route
app.post("/api/login", (req, res) => {
    const { email, password } = req.body;
    if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '1h' });
        res.json({ token, email });
    } else {
        res.status(401).json({ error: "Invalid credentials." });
    }
});

// Get all images
app.get("/api/images", async (req, res) => {
    try {
        if (cosmosContainer) {
            const { resources } = await cosmosContainer.items.query("SELECT * from c").fetchAll();
            return res.json(resources);
        } else {
            return res.json(localImages);
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to fetch images" });
    }
});

// Upload image
app.post("/api/images", verifyToken, upload.single("image"), async (req, res) => {
    try {
        let imageUrl = null;

        if (req.file) {
            if (containerClient) {
                // Upload to Azure Blob
                const blobName = Date.now() + "-" + req.file.originalname;
                const blockBlobClient = containerClient.getBlockBlobClient(blobName);
                await blockBlobClient.uploadData(req.file.buffer, {
                    blobHTTPHeaders: { blobContentType: req.file.mimetype }
                });
                imageUrl = blockBlobClient.url;
            } else {
                // Fallback to local disk
                const uniqueName = Date.now() + path.extname(req.file.originalname);
                fs.writeFileSync(path.join(uploadDir, uniqueName), req.file.buffer);
                imageUrl = `http://localhost:${process.env.PORT || 3000}/uploads/${uniqueName}`;
            }
        }

        const newImage = {
            id: Date.now().toString(),
            title: req.body.title,
            category: req.body.category,
            imageUrl: imageUrl || req.body.imageUrl, // Fallback if passed directly
            uploadedBy: req.body.uploadedBy || 'Anonymous',
            uploadedTime: new Date().toISOString()
        };

        if (cosmosContainer) {
            const { resource } = await cosmosContainer.items.create(newImage);
            res.json(resource);
        } else {
            localImages.push(newImage);
            res.json(newImage);
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to upload image" });
    }
});

// Update image details (PUT)
app.put("/api/images/:id", verifyToken, async (req, res) => {
    try {
        const { title, category } = req.body;
        const { id } = req.params;

        if (cosmosContainer) {
            const { resource: existingImage } = await cosmosContainer.item(id, id).read();
            if (!existingImage) {
                return res.status(404).json({ error: "Image not found" });
            }
            existingImage.title = title;
            existingImage.category = category;

            const { resource: updatedImage } = await cosmosContainer.item(id, id).replace(existingImage);
            res.json(updatedImage);
        } else {
            const image = localImages.find(img => img.id === id);
            if (!image) {
                return res.status(404).json({ error: "Image not found" });
            }
            image.title = title;
            image.category = category;
            res.json(image);
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to update image" });
    }
});

// Delete image
app.delete("/api/images/:id", verifyToken, async (req, res) => {
    try {
        const { id } = req.params;

        if (cosmosContainer) {
            const { resource: imageToDelete } = await cosmosContainer.item(id, id).read();

            if (imageToDelete && imageToDelete.imageUrl && containerClient) {
                try {
                    const urlParts = new URL(imageToDelete.imageUrl);
                    const blobName = urlParts.pathname.split('/').pop();
                    await containerClient.getBlockBlobClient(blobName).deleteIfExists();
                } catch (e) {
                    console.error("Failed to delete blob:", e);
                }
            }

            await cosmosContainer.item(id, id).delete();
            res.json({ message: "Deleted successfully" });
        } else {
            const imageToDelete = localImages.find((img) => img.id === id);

            if (imageToDelete && imageToDelete.imageUrl) {
                try {
                    const filename = imageToDelete.imageUrl.split("/uploads/")[1];
                    if (filename) {
                        const filePath = path.join(uploadDir, filename);
                        if (fs.existsSync(filePath)) {
                            fs.unlinkSync(filePath);
                        }
                    }
                } catch (e) {
                    console.error(e);
                }
            }

            localImages = localImages.filter((img) => img.id !== id);
            res.json({ message: "Deleted successfully" });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Failed to delete image" });
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));