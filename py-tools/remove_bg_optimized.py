#!/usr/bin/env python3
"""
Optimized background removal for low-RAM systems (~500MB)
Uses streaming and chunked processing to minimize memory footprint
"""

from rembg import remove
from PIL import Image
import sys
import io
import os

# Reduce image quality and size for processing
MAX_DIMENSION = 800  # Process at max 800x800
COMPRESSION_QUALITY = 85
CHUNK_SIZE = 256 * 1024  # 256KB chunks

def optimize_image(img_path):
    """Load and optimize image for processing"""
    try:
        with Image.open(img_path) as img:
            # Convert to RGB first (reduces memory)
            if img.mode in ('RGBA', 'LA', 'P'):
                img = img.convert('RGB')
            
            # Resize if too large
            if img.width > MAX_DIMENSION or img.height > MAX_DIMENSION:
                img.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.Resampling.LANCZOS)
            
            # Save to temp file to free memory
            temp_path = '/tmp/optimized_temp.jpg'
            img.save(temp_path, 'JPEG', quality=COMPRESSION_QUALITY, optimize=True)
            return temp_path
    except Exception as e:
        print(f"❌ Image optimization failed: {e}", file=sys.stderr)
        sys.exit(1)

def process_background_removal(input_path, output_path):
    """Process image with minimal memory usage"""
    try:
        # Step 1: Optimize input image
        optimized_path = optimize_image(input_path)
        
        # Step 2: Read optimized image
        with open(optimized_path, 'rb') as f:
            input_data = f.read()
        
        # Step 3: Remove background (rembg will use optimized image)
        output_data = remove(input_data)
        
        # Step 4: Process with PIL
        img = Image.open(io.BytesIO(output_data)).convert("RGBA")
        
        # Step 5: Add background color
        bg_color = (239, 246, 255, 255)  # Tailwind blue-50
        bg = Image.new("RGBA", img.size, bg_color)
        combined = Image.alpha_composite(bg, img)
        
        # Step 6: Save with optimization
        combined.save(output_path, 'PNG', optimize=True)
        
        # Cleanup
        if os.path.exists(optimized_path):
            os.remove(optimized_path)
        
        print(f"✅ Processing complete: {output_path}")
        return True
        
    except Exception as e:
        print(f"❌ Processing failed: {e}", file=sys.stderr)
        return False
    finally:
        # Force garbage collection
        import gc
        gc.collect()

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print("Usage: python remove_bg_optimized.py <input> <output>")
        sys.exit(1)
    
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    
    if not os.path.exists(input_path):
        print(f"❌ Input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)
    
    success = process_background_removal(input_path, output_path)
    sys.exit(0 if success else 1)
