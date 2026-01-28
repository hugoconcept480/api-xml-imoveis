const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const { XMLParser, XMLBuilder } = require("fast-xml-parser");

// --- FUNÇÕES AUXILIARES DE MAPEAMENTO ---

// 1. Mapeia VENDA/ALUGUEL para o padrão do Facebook
function mapListingType(operacao) {
    if (!operacao) return 'for_sale_by_agent'; // Padrão
    const op = operacao.toUpperCase();
    if (op.includes('ALUGUEL') || op.includes('LOCAÇÃO')) {
        return 'for_rent_by_agent';
    }
    return 'for_sale_by_agent';
}

// 2. Mapeia o Tipo do Imóvel (Português -> Inglês do Facebook)
function mapPropertyType(tipo) {
    if (!tipo) return 'other';
    const t = tipo.toUpperCase();
    
    if (t.includes('APARTAMENTO') || t.includes('FLAT') || t.includes('COBERTURA')) return 'apartment';
    if (t.includes('CASA') || t.includes('SOBRADO')) return 'house';
    if (t.includes('LOTE') || t.includes('TERRENO')) return 'land';
    if (t.includes('COMERCIAL') || t.includes('LOJA') || t.includes('SALA')) return 'other';
    
    return 'other'; // Padrão se não achar nada
}

// 3. Formata Preço (Remove erros e garante BRL)
function formatPrice(valor) {
    if (!valor) return '0.00 BRL';
    // Garante que seja numero
    const num = parseFloat(valor);
    return `${num.toFixed(2)} BRL`;
}

// --- FUNÇÃO PRINCIPAL ---

exports.handler = async function(event, context) {
    const params = event.queryStringParameters || {};
    let clientHash = params.hash;

    // Tenta pegar hash da URL se não vier por parametro
    if (!clientHash && event.path) {
        const parts = event.path.split('/');
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart !== 'feed') {
            clientHash = lastPart;
        }
    }

    const clientDomain = params.domain || 'seusite.com.br';

    if (!clientHash) {
        return { statusCode: 400, body: "Hash obrigatorio." };
    }

    const SOURCE_URL = `https://xml.imob86.conceptsoft.com.br/Imob86XML/listar/${clientHash}`;

    try {
        const response = await fetch(SOURCE_URL, { timeout: 15000 }); // Aumentei timeout pra 15s
        if (!response.ok) {
            return { statusCode: 502, body: `Erro na Origem: ${response.status}` };
        }
        const xmlText = await response.text();

        const parser = new XMLParser({ ignoreAttributes: false });
        const jsonObj = parser.parse(xmlText);

        let imoveis = [];
        // Verifica se existe a tag <imoveis> e <imovel>
        if (jsonObj.imoveis && jsonObj.imoveis.imovel) {
            // Se tiver só 1 imóvel, o parser retorna objeto. Se tiver vários, retorna array.
            // Essa linha garante que sempre seja um Array para não quebrar o loop.
            imoveis = Array.isArray(jsonObj.imoveis.imovel) ? jsonObj.imoveis.imovel : [jsonObj.imoveis.imovel];
        }

        const rssItems = [];
        
        for (const imovel of imoveis) {
            try {
                // Função segura para pegar valor (trata nulos e objetos vazios)
                const getVal = (val) => {
                    if (val === undefined || val === null) return "";
                    if (typeof val === 'object' && Object.keys(val).length === 0) return ""; // Caso de tag vazia <tag/>
                    return val;
                };

                const id = getVal(imovel.idNaImobiliaria);
                if (!id) continue; // Sem ID não serve pro Facebook

                // Dados Básicos
                const bairro = imovel.bairro ? getVal(imovel.bairro.nome) : "";
                const tipoNome = imovel.tipoImovel ? getVal(imovel.tipoImovel.nome) : "";
                const cidade = imovel.cidade ? getVal(imovel.cidade.nome) : "";
                
                // Título Inteligente
                let titulo = getVal(imovel.tituloSite);
                if (!titulo) {
                    // Ex: "Apartamento em Dirceu I - Teresina"
                    titulo = `${tipoNome} em ${bairro}`; 
                    if (cidade) titulo += ` - ${cidade}`;
                }

                // Preço
                const price = formatPrice(imovel.valor);

                // Mapeamentos para o Facebook
                const operacao = getVal(imovel.operacao); // ALUGUEL ou VENDA
                const listingType = mapListingType(operacao);
                const propertyType = mapPropertyType(tipoNome);

                // Link e Descrição
                const link = `https://${clientDomain}/imovel/${id}`;
                const rawDesc = getVal(imovel.descricao);
                // Limita descrição a 4900 chars (limite do Google/Meta é 5000)
                const description = String(rawDesc).substring(0, 4900) || titulo;

                // Endereço
                const endereco = getVal(imovel.endereco);
                const cep = getVal(imovel.cep);
                
                // Latitude/Longitude (Se tiver no XML, usamos. Se for 0.0, não mandamos pra não dar erro de validação)
                const lat = parseFloat(imovel.latitude);
                const long = parseFloat(imovel.longitude);
                
                // Imagens
                let additionalImages = [];
                let imageLink = "";
                
                if (imovel.imagens && imovel.imagens.imagem) {
                    const imgs = Array.isArray(imovel.imagens.imagem) ? imovel.imagens.imagem : [imovel.imagens.imagem];
                    if (imgs.length > 0) {
                        // Pega o PATH. Se o path for objeto, tenta converter, mas no seu XML parece string direta dentro de path.
                        imageLink = imgs[0].path; 
                        // Facebook aceita até 20 imagens. Pegamos as próximas 10.
                        additionalImages = imgs.slice(1, 11).map(img => img.path);
                    }
                }

                // Quartos e Banheiros
                const quartos = getVal(imovel.quartos) || "0";
                const banheiros = getVal(imovel.banheiros) || "0";
                const area = getVal(imovel.area);

                // Monta o objeto do item
                const itemObj = {
                    "g:home_listing_id": id,
                    "title": titulo,
                    "g:description": description,
                    "g:price": price,
                    "g:listing_type": listingType, // Agora dinâmico (For Rent / For Sale)
                    "g:property_type": propertyType, // Agora dinâmico (House / Apartment / Land)
                    "link": link,
                    "g:image_link": imageLink,
                    "g:address": {
                        "@_format": "struct",
                        "g:addr1": endereco,
                        "g:city": cidade,
                        "g:region": getVal(imovel.estado?.nome) || "PI",
                        "g:postal_code": cep,
                        "g:country": "BR"
                    },
                    "g:neighborhood": bairro,
                    "g:num_beds": quartos,
                    "g:num_baths": banheiros,
                };

                // Adiciona imagens extras se tiver
                if (additionalImages.length > 0) {
                    itemObj["g:additional_image_link"] = additionalImages;
                }

                // Adiciona Lat/Long apenas se forem válidos (diferente de 0)
                if (lat !== 0 && long !== 0) {
                    itemObj["g:latitude"] = lat;
                    itemObj["g:longitude"] = long;
                }
                
                // Adiciona área se tiver
                 if (area && area != "0.0") {
                    itemObj["g:area"] = {
                        "#text": area,
                        "@_unit": "sq m" // Metros quadrados
                    };
                }

                rssItems.push(itemObj);

            } catch (err) {
                console.log(`Erro ao processar imóvel ID ${imovel.idNaImobiliaria || 'desconhecido'}:`, err.message);
                continue;
            }
        }

        // 5. Construir XML Final
        const builder = new XMLBuilder({ 
            format: true, 
            ignoreAttributes: false,
            cdataPropName: "title" // Opcional: protege caracteres especiais no título
        });
        
        const finalObj = {
            rss: {
                "@_xmlns:g": "http://base.google.com/ns/1.0",
                "@_version": "2.0",
                channel: {
                    title: "Feed Imoveis",
                    description: "Integração Imob86 para Meta Ads",
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
                'Cache-Control': 'public, max-age=1800' // Cache de 30 minutos
            },
            body: finalXml
        };

    } catch (error) {
        console.error(error);
        return { statusCode: 500, body: `Erro interno: ${error.toString()}` };
    }
};
