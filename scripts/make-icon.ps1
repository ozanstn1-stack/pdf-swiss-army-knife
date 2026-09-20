# Generates the application icon (PNG) used by `tauri icon`.
# Design: rounded dark tile, white PDF page with folded corner, accent wrench.
Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)

# rounded tile with vertical gradient
$rect = New-Object System.Drawing.Rectangle(32, 32, 960, 960)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 210
$path.AddArc($rect.X, $rect.Y, $radius, $radius, 180, 90)
$path.AddArc($rect.Right - $radius, $rect.Y, $radius, $radius, 270, 90)
$path.AddArc($rect.Right - $radius, $rect.Bottom - $radius, $radius, $radius, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $radius, $radius, $radius, 90, 90)
$path.CloseFigure()

$gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(255, 30, 41, 59),
    [System.Drawing.Color]::FromArgb(255, 15, 23, 42),
    90.0)
$g.FillPath($gradient, $path)

# accent glow
$accentBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(38, 99, 102, 241))
$g.FillEllipse($accentBrush, 210, 120, 700, 700)

# PDF page
$page = New-Object System.Drawing.Drawing2D.GraphicsPath
$px = 280; $py = 210; $pw = 360; $ph = 470; $fold = 96
$page.AddLine($px, $py, $px + $pw - $fold, $py)
$page.AddLine($px + $pw - $fold, $py, $px + $pw, $py + $fold)
$page.AddLine($px + $pw, $py + $fold, $px + $pw, $py + $ph)
$page.AddLine($px + $pw, $py + $ph, $px, $py + $ph)
$page.CloseFigure()

$pageBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 248, 250, 252))
$g.FillPath($pageBrush, $page)

# folded corner
$foldPath = New-Object System.Drawing.Drawing2D.GraphicsPath
$foldPath.AddLine($px + $pw - $fold, $py, $px + $pw - $fold, $py + $fold)
$foldPath.AddLine($px + $pw - $fold, $py + $fold, $px + $pw, $py + $fold)
$foldPath.CloseFigure()
$foldBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 199, 210, 254))
$g.FillPath($foldBrush, $foldPath)

# "PDF" text
$font = New-Object System.Drawing.Font('Segoe UI', 96, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 15, 23, 42))
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$g.DrawString('PDF', $font, $textBrush, (New-Object System.Drawing.RectangleF(($px), ($py + 150), $pw, 140)), $format)

# text lines
$linePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(170, 100, 116, 139), 18)
$linePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$linePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawLine($linePen, $px + 60, $py + 320, $px + $pw - 60, $py + 320)
$g.DrawLine($linePen, $px + 60, $py + 380, $px + $pw - 60, $py + 380)

# wrench (accent) overlaid bottom-right
$wrench = New-Object System.Drawing.Drawing2D.GraphicsPath
$wx = 600; $wy = 560
$wrench.AddEllipse($wx, $wy, 190, 190)
$holeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 30, 41, 59))
$g.FillPath($holeBrush, $wrench)
$accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 129, 140, 248))
$g.FillEllipse($accent, $wx + 26, $wy + 26, 138, 138)
$innerBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 30, 41, 59))
$g.FillEllipse($innerBrush, $wx + 62, $wy + 62, 66, 66)
$handlePen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 129, 140, 248), 74)
$handlePen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$handlePen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawLine($handlePen, $wx + 95, $wy + 95, 400, 890)

$g.Dispose()
$out = Join-Path $PSScriptRoot '..\assets\icon-source.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Host "icon written: $out"
