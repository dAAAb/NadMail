/**
 * NNS Price Scraper
 * 從 nad.domains 前端取得真實價格（含折扣）
 */

export async function getNnsPriceFromFrontend(name: string): Promise<{
  price: number;
  discount: number;
  available: boolean;
} | null> {
  try {
    // 使用 Workers 的 fetch（不依賴外部 library）
    const response = await fetch(`https://app.nad.domains/register-confirm?name=${encodeURIComponent(name)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NadMail/1.0)',
      },
    });
    
    if (!response.ok) return null;
    
    const html = await response.text();
    
    // 解析價格
    // Registration fee: XXX MON
    const priceMatch = html.match(/Registration fee[\s\S]*?(\d+)\s*MON/i);
    const discountMatch = html.match(/Discount:\s*([-\d]+)%/i);
    const availableMatch = html.match(/Available/i);
    
    if (!priceMatch) return null;
    
    return {
      price: parseInt(priceMatch[1]),
      discount: discountMatch ? parseInt(discountMatch[1]) : 0,
      available: availableMatch !== null,
    };
  } catch (error) {
    console.error('[nns-price-scraper] Error:', error);
    return null;
  }
}
