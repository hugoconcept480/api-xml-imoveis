const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { XMLParser, XMLBuilder } = require("fast-xml-parser");

// --- 1. CONFIGURAÇÃO DO SEU DOMÍNIO ---
// Coloque aqui o site da sua imobiliária para não ficar "seusite.com.br"
// Exemplo: "www.imobiliariax.com.br"
const DOMINIO_PADRAO = "www.suaimobiliaria.com.br"; 

// --- 2. FUNÇÕES DE TRADUÇÃO (Meta Ads) ---

function mapListingType(operacao) {
    if (!operacao) return 'for_sale_by_agent'; 
    const op = String(operacao).toUpperCase();
    // Se tiver "ALUGUEL" no nome, vira aluguel no Facebook
    if (op.includes('ALUGUEL') || op.includes('LOCAÇÃO')) {
        return 'for_rent_by_agent';
    }
    return 'for_sale_by_agent';
}

function mapPropertyType(tipo) {
    if (!tipo) return 'other';
    const t = String(tipo).toUpperCase();
    
    // Mapeamento Português -> Inglês (Padrão Meta)
    if (t.includes('APARTAMENTO') || t.includes('FLAT') || t.includes('KITNET')) return 'apartment';
    if (t.includes('CASA') || t.includes('SOBRADO')) return 'house';
    if (t.includes('LOTE') || t.includes('TERRENO')) return 'land';
    
    return 'other'; 
}

function formatPrice(valor) {
    if (!valor) return '0.00 BRL';
    return `${parseFloat(valor).toFixed(2)} BRL`;
}

// --- 3. FUNÇÃO PRINCIPAL ---

exports.handler = async function(event, context) {
    const params = event.queryStringParameters || {};
    let clientHash = params.hash;

    // Pega o hash da URL amigável (/feed/HASH)
    if (!clientHash && event.path) {
        const parts = event.path.split('/');
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart !== 'feed') {
            clientHash = lastPart;
        }
    }

    // Define o domínio: ou vem pela URL (?domain=x) ou usa o padrão que definimos acima
    const clientDomain = params.domain || DOMINIO_PADRAO;

    if (!clientHash) {
        return { statusCode: 400, body: "Hash obrigatorio." };
    }

    const SOURCE_URL = `https://xml.imob86.conceptsoft.com.br/Imob86XML/listar/${clientHash}`;

    try {
        // Timeout aumentado para garantir que dê tempo de baixar o XML grande
        const response = await fetch(SOURCE_URL, { timeout: 15000 });
        if (!response.ok) {
            return { statusCode: 502, body: `Erro na Origem: ${response.status}` };
        }
        const xmlText = await response.text();

        const parser = new XMLParser({ ignoreAttributes: false });
        const jsonObj = parser.parse(xmlText);

        let imoveis = [];
        if (jsonObj.imoveis && jsonObj.imoveis.imovel) {
            // Garante que seja sempre uma lista (Array)
            imoveis = Array.isArray(jsonObj.imoveis.imovel) ? jsonObj.imoveis.imovel : [jsonObj.imoveis.imovel];
        }

        const rssItems = [];
        
        for (const imovel of imoveis) {
            try {
                // Função auxiliar para evitar erro se o campo não existir
                const getVal = (val) => {
                    if (val === undefined || val === null) return "";
                    // Se for objeto vazio (ex: <tag/>), retorna vazio
                    if (typeof val === 'object' && Object.keys(val).length === 0) return ""; 
                    return val;
                };

                const id = getVal(imovel.idNaImobiliaria);
                if (!id) continue; 

                // --- DADOS DO IMÓVEL ---
                const bairro = imovel.bairro ? getVal(imovel.bairro.nome) : "";
                const cidade = imovel.cidade ? getVal(imovel.cidade.nome) : "";
                const tipoNome = imovel.tipoImovel ? getVal(imovel.tipoImovel.nome) : "Imóvel";
                
                // Título Automático (se não tiver no XML)
                let titulo = getVal(imovel.tituloSite);
                if (!titulo) {
                    titulo = `${tipoNome} em ${bairro}`; 
                    if (cidade) titulo += ` - ${cidade}`;
                }

                // Descrição e Preço
                const rawDesc = getVal(imovel.descricao);
                const description = String(rawDesc).substring(0, 4900) || titulo;
                const price = formatPrice(imovel.valor);

                // --- TRADUÇÃO DE CAMPOS (A Mágica acontece aqui) ---
                const operacao = getVal(imovel.operacao); // Ex: ALUGUEL
                const listingType = mapListingType(operacao); // Vira: for_rent_by_agent

                const propertyType = mapPropertyType(tipoNome); // Ex: Casa -> house

                // Link Correto
                const link = `https://${clientDomain}/imovel/${id}`;

                // Imagens
                let additionalImages = [];
                let imageLink = "";
                
                if (imovel.imagens && imovel.imagens.imagem) {
                    const imgs = Array.isArray(imovel.imagens.imagem) ? imovel.imagens.imagem : [imovel.imagens.imagem];
                    if (imgs.length > 0) {
                        imageLink = getVal(imgs[0].path);
                        // Pega até 10 fotos adicionais
                        additionalImages = imgs.slice(1, 11).map(img => getVal(img.path)).filter(p => p !== "");
                    }
                }

                // --- CORREÇÃO DE QUARTOS/BANHEIROS ---
                // Forçamos conversão para String para evitar que o número 0 suma
                const quartos = String(getVal(imovel.quartos) || "0");
                const banheiros = String(getVal(imovel.banheiros) || "0");
                const area = String(getVal(imovel.area) || "0");

                const itemObj = {
                    "g:home_listing_id": id,
                    "title": titulo,
                    "g:description": description,
                    "g:price": price,
                    "g:listing_type": listingType, 
                    "g:property_type": propertyType,
                    "link": link,
                    "g:image_link": imageLink,
                    "g:address": {
                        "@_format": "struct",
                        "g:addr1": getVal(imovel.endereco),
                        "g:city": cidade,
                        "g:region": getVal(imovel.estado?.nome) || "PI",
                        "g:postal_code": getVal(imovel.cep),
                        "g:country": "BR"
                    },
                    "g:neighborhood": bairro,
                    "g:num_beds": quartos,
                    "g:num_baths": banheiros,
                };

                // Adicionais condicionais (só adiciona se tiver dados)
                if (additionalImages.length > 0) itemObj["g:additional_image_link"] = additionalImages;
                if (area !== "0") itemObj["g:area"] = { "#text": area, "@_unit": "sq m" };

                rssItems.push(itemObj);

            } catch (err) {
                console.log(`Erro item ${imovel.idNaImobiliaria}:`, err.message);
                continue;
            }
        }

        // XML Final
        const builder = new XMLBuilder({ format: true, ignoreAttributes: false, cdataPropName: "title" });
        const finalObj = {
            rss: {
                "@_xmlns:g": "http://base.google.com/ns/1.0",
                "@_version": "2.0",
                channel: {
                    title: "Feed Imoveis",
                    description: "Integração Imob86 Meta Ads",
                    link: `https://${clientDomain}`,
                    item: rssItems
                }
            }
        };

        const finalXml = `<?xml version="1.0" encoding="UTF-8"?>\n` + builder.build(finalObj);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/xml; charset=utf-8',
                'Cache-Control': 'public, max-age=3600'
            },
            body: finalXml
        };

    } catch (error) {
        return { statusCode: 500, body: error.toString() };
    }
};
